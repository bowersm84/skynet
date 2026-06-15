import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { uploadDocument, getDocumentUrl, deleteDocument } from '../lib/s3'
import {
  Package,
  Wrench,
  Plus,
  Search,
  Edit2,
  Trash2,
  X,
  Loader2,
  ChevronDown,
  ChevronUp,
  ChevronRight,
  Check,
  AlertTriangle,
  Beaker,
  Layers,
  Database,
  Upload,
  Route,
  BarChart2,
  PackageCheck,
  GripVertical,
  Users,
  Power,
  PowerOff,
  Paperclip,
  ExternalLink
} from 'lucide-react'
import BOMUpload from '../components/BOMUpload'
import RoutingTemplatesTab from '../components/RoutingTemplatesTab'
import UsersTab from './UsersTab'
import CustomersTab from './CustomersTab'
import { isReadOnlyRole } from '../lib/roles'

export default function Armory({ profile }) {
  const canWrite = !isReadOnlyRole(profile?.role)
  // Per-role tab visibility. Single source of truth.
  // Order in each array determines the default tab for that role (first item).
  // Read-only roles (president, viewer) get the read-relevant tab set
  // (no Users, no Receiving); write buttons inside these tabs are gated on canWrite.
  const TAB_ACCESS_BY_ROLE = {
    admin:            ['assemblies', 'components', 'materials', 'barsizes', 'routing', 'material_master', 'inventory', 'reconciliation', 'receiving', 'customers', 'users'],
    compliance:       ['assemblies', 'components', 'materials', 'barsizes', 'routing', 'material_master', 'inventory', 'reconciliation', 'receiving'],
    finishing:        ['inventory', 'reconciliation', 'receiving'],
    machinist:        ['inventory', 'reconciliation'],
    scheduler:        ['customers'],
    customer_service: ['customers'],
    president:        ['assemblies', 'components', 'materials', 'barsizes', 'routing', 'material_master', 'inventory', 'reconciliation', 'customers'],
    viewer:           ['assemblies', 'components', 'materials', 'barsizes', 'routing', 'material_master', 'inventory', 'reconciliation', 'customers'],
  }
  const visibleTabIds = TAB_ACCESS_BY_ROLE[profile?.role] || []
  const canSeeTab = (tabId) => visibleTabIds.includes(tabId)

  // Default to first visible tab for this role (falls back to 'assemblies' for admin)
  const [activeTab, setActiveTab] = useState(visibleTabIds[0] || 'assemblies')
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [activeFilter, setActiveFilter] = useState('active') // 'active' | 'inactive' | 'all'

  // Data
  const [parts, setParts] = useState([])
  const [pendingCOByPart, setPendingCOByPart] = useState({})
  const [materialTypes, setMaterialTypes] = useState([])
  const [barSizes, setBarSizes] = useState([])
  const [routingTemplates, setRoutingTemplates] = useState([])
  
  // Modals
  const [showPartModal, setShowPartModal] = useState(false)
  const [showBOMModal, setShowBOMModal] = useState(false)
  const [showBOMUpload, setShowBOMUpload] = useState(false)
  const [showMaterialModal, setShowMaterialModal] = useState(false)
  const [showBarSizeModal, setShowBarSizeModal] = useState(false)
  
  // Edit state
  const [editingPart, setEditingPart] = useState(null)
  const [editingMaterial, setEditingMaterial] = useState(null)
  const [editingBarSize, setEditingBarSize] = useState(null)
  const [selectedAssembly, setSelectedAssembly] = useState(null)
  
  // Forms
  const [partForm, setPartForm] = useState({
    part_number: '',
    description: '',
    part_type: 'manufactured',
    customer: '',
    specification: '',
    requires_passivation: false,
    unit_cost: 0,
    material_type_id: null,
    drawing_revision: '',
    is_active: true
  })
  
  const [materialForm, setMaterialForm] = useState({
    name: '',
    short_code: '',
    category: ''
  })
  
  const [barSizeForm, setBarSizeForm] = useState({
    size: '',
    size_decimal: '',
    shape: 'round'
  })
  
  // BOM management
  const [bomComponents, setBomComponents] = useState([])
  const [availableComponents, setAvailableComponents] = useState([])
  
  // Machine preferences for part modal
  const [machines, setMachines] = useState([])
  const [preferredMachineId, setPreferredMachineId] = useState(null)
  const [secondaryMachineIds, setSecondaryMachineIds] = useState([]) // up to 5

  // Routing steps for part modal
  const [routingSteps, setRoutingSteps] = useState([])
  const [draggedStepIdx, setDraggedStepIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)

  // Document requirements for part modal
  const [documentTypes, setDocumentTypes] = useState([])
  const [docRequirements, setDocRequirements] = useState([])
  const [showDocRequirements, setShowDocRequirements] = useState(false)

  // Material Master & Receiving
  const [materials, setMaterials] = useState([])
  const [receivingLog, setReceivingLog] = useState([])
  const [showMaterialMasterModal, setShowMaterialMasterModal] = useState(false)
  const [showReceivingModal, setShowReceivingModal] = useState(false)
  const [editingMaterialMaster, setEditingMaterialMaster] = useState(null)
  const [materialMasterForm, setMaterialMasterForm] = useState({
    material_type_id: '',
    bar_size_inches: '',
    density_lbs_per_cubic_inch: '',
    vendor: '',
    notes: ''
  })
  // Reference counts per material id, used to gate hard-delete.
  const [materialRefCounts, setMaterialRefCounts] = useState({})
  // Inline modal state for the Add/Edit Material modal: validation error + a
  // staged inactive duplicate that the user can choose to reactivate.
  const [materialModalError, setMaterialModalError] = useState('')
  const [existingInactive, setExistingInactive] = useState(null)
  // Material chosen for hard-delete; drives the delete confirmation modal.
  const [materialToDelete, setMaterialToDelete] = useState(null)
  const [receivingForm, setReceivingForm] = useState({
    material_id: '',
    vendor: '',
    po_number: '',
    lot_number: '',
    quantity: '',
    bar_length_inches: '',
    weight_lbs: '',
    price_per_lb: '',
    price_per_bar: '',
    rack: '',
    notes: ''
  })
  // Inline validation error for the receiving modal (no alert()).
  const [receivingError, setReceivingError] = useState('')
  // Split material selectors (vendor → type → size) resolve receivingForm.material_id.
  const [receivingTypeId, setReceivingTypeId] = useState('')
  const [receivingSize, setReceivingSize] = useState('')
  // Cert files staged in the modal before save; uploaded after the receipt insert.
  const [receivingCertFiles, setReceivingCertFiles] = useState([])
  // Set when the receipt saved but a cert upload failed — guards against duplicate saves.
  const [savedReceiptId, setSavedReceiptId] = useState(null)
  const [inventoryRows, setInventoryRows] = useState([])
  const [invFilterMaterial, setInvFilterMaterial] = useState('')
  const [invFilterRack, setInvFilterRack] = useState('')
  const [invFilterVendor, setInvFilterVendor] = useState('')
  const [invFilterSize, setInvFilterSize] = useState('')
  const [invSearchLot, setInvSearchLot] = useState('')
  const [invSortKey, setInvSortKey] = useState('material_type') // material_type | bar_size | lot_number | available_bars
  const [invViewMode, setInvViewMode] = useState('lot') // 'lot' | 'size' (roll-up by material + size)
  const [invSortDir, setInvSortDir] = useState('asc')
  const [assigningRack, setAssigningRack] = useState(null)
  const [rawMenuOpen, setRawMenuOpen] = useState(false) // Raw Materials tab-group dropdown
  // material_receiving_id → cert document count (single batched query)
  const [materialDocCounts, setMaterialDocCounts] = useState({})
  // Lot Documents modal (after-the-fact uploads from the Inventory tab)
  const [docsModalRow, setDocsModalRow] = useState(null)
  const [lotDocs, setLotDocs] = useState([])
  const [lotDocsLoading, setLotDocsLoading] = useState(false)
  const [docUploading, setDocUploading] = useState(false)
  const [docModalError, setDocModalError] = useState('')
  // Materials (Raw Material master) tab filters
  const [matFilterType, setMatFilterType] = useState('')
  const [matFilterVendor, setMatFilterVendor] = useState('')
  const [matFilterSize, setMatFilterSize] = useState('')
  // Reconciliation flags (inventory discrepancies raised by the DB trigger)
  const [reconFlags, setReconFlags] = useState([])
  const [reconFilter, setReconFilter] = useState('open') // 'all' | 'open' | 'resolved' | 'ignored'
  const [openFlagCount, setOpenFlagCount] = useState(0)
  const [resolvingFlag, setResolvingFlag] = useState(null) // flag row being resolved
  const [resolutionNotes, setResolutionNotes] = useState('')
  const [resolvingSaving, setResolvingSaving] = useState(false)
  // Late-receipt linking: receipts + orphaned staging rows for an unknown_lot flag.
  const [resolveError, setResolveError] = useState('')
  const [resolveReceipts, setResolveReceipts] = useState([])
  const [resolveOrphans, setResolveOrphans] = useState([])
  const [resolveSelectedReceiptId, setResolveSelectedReceiptId] = useState('')
  const [resolveLoading, setResolveLoading] = useState(false)
  // Non-blocking warning banner when a link raises a negative_inventory flag.
  const [negFlagToast, setNegFlagToast] = useState('')
  // Receiving-save nudge to link already-staged material to the new receipt.
  const [receivingNudge, setReceivingNudge] = useState(null) // { flagId, receivingId, lotNumber, totalBars, events, sampleJob }
  const [nudgeSaving, setNudgeSaving] = useState(false)
  const [nudgeError, setNudgeError] = useState('')
  // Link actions are restricted to admin/compliance (RPC enforces it too).
  const canLink = ['admin', 'compliance'].includes(profile?.role)
  // Receiving form only offers active materials; inactive ones are admin-only.
  const materialVendors = [...new Set(
    materials.filter(m => m.vendor && m.is_active).map(m => m.vendor)
  )].sort()
  // Split selectors: distinct types for the vendor, then sizes for vendor + type.
  const receivingTypes = receivingForm.vendor
    ? [...new Map(
        materials
          .filter(m => m.vendor === receivingForm.vendor && m.is_active && m.material_type)
          .map(m => [m.material_type.id, m.material_type])
      ).values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    : []
  const receivingSizes = (receivingForm.vendor && receivingTypeId)
    ? [...new Set(
        materials
          .filter(m => m.vendor === receivingForm.vendor && m.is_active && String(m.material_type?.id) === String(receivingTypeId))
          .map(m => m.bar_size_inches)
      )].sort((a, b) => Number(a) - Number(b))
    : []

  // Loading states
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)

  // Fetch all data
  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      // Fetch parts with BOM
      const { data: partsData, error: partsError } = await supabase
        .from('parts')
        .select(`
          *,
          assembly_bom!assembly_bom_assembly_id_fkey (
            id,
            quantity,
            sort_order,
            component:parts!assembly_bom_component_id_fkey (
              id,
              part_number,
              description,
              part_type,
              is_active,
              requires_passivation
            )
          )
        `)
        .order('part_number')

      if (partsError) throw partsError
      setParts(partsData || [])

      // Pending CO line count per part (open lines on non-cancelled COs).
      // Used to sort inactive parts with pending demand to the top and badge them.
      const { data: pendingCOLines } = await supabase
        .from('customer_order_lines')
        .select('part_id, status, customer_order_id, customer_orders!inner(status)')
        .in('status', ['not_started', 'in_progress'])
        .neq('customer_orders.status', 'cancelled')

      const countByPart = {}
      for (const row of (pendingCOLines || [])) {
        countByPart[row.part_id] = (countByPart[row.part_id] || 0) + 1
      }
      setPendingCOByPart(countByPart)

      // Fetch material types
      const { data: materialsData, error: materialsError } = await supabase
        .from('material_types')
        .select('*')
        .eq('is_active', true)
        .order('name')

      if (materialsError) throw materialsError
      setMaterialTypes(materialsData || [])

      // Fetch bar sizes
      const { data: barSizesData, error: barSizesError } = await supabase
        .from('bar_sizes')
        .select('*')
        .eq('is_active', true)
        .order('size_decimal')

      if (barSizesError) throw barSizesError
      setBarSizes(barSizesData || [])

      // Fetch material master records (active + inactive; sorted active-first, then by vendor)
      const { data: materialMasterData, error: materialMasterError } = await supabase
        .from('materials')
        .select(`
          id, material_type_id, bar_size_inches, density_lbs_per_cubic_inch,
          vendor, notes, is_active, created_at,
          material_type:material_types ( id, name, short_code )
        `)
        .order('is_active', { ascending: false })
        .order('vendor')
      if (!materialMasterError) setMaterials(materialMasterData || [])

      // Reference counts: how many material_receiving + material_usage rows
      // point at each material? Used to disable hard-delete on referenced rows.
      const [{ data: receivingRefs }, { data: usageRefs }] = await Promise.all([
        supabase.from('material_receiving').select('material_id'),
        supabase.from('material_usage').select('material_id'),
      ])
      const refs = {}
      for (const row of [...(receivingRefs || []), ...(usageRefs || [])]) {
        if (row.material_id) refs[row.material_id] = (refs[row.material_id] || 0) + 1
      }
      setMaterialRefCounts(refs)

      // Fetch receiving log (all records)
      const { data: receivingData } = await supabase
        .from('material_receiving')
        .select('*, received_by_profile:profiles!received_by(full_name)')
        .order('received_at', { ascending: false })
      setReceivingLog(receivingData || [])

      // Cert document counts per receiving row (single batched query).
      const { data: docRows } = await supabase
        .from('material_documents')
        .select('material_receiving_id')
      const docCounts = {}
      for (const d of (docRows || [])) {
        if (d.material_receiving_id) docCounts[d.material_receiving_id] = (docCounts[d.material_receiving_id] || 0) + 1
      }
      setMaterialDocCounts(docCounts)

      // Fetch machines
      const { data: machinesData, error: machinesError } = await supabase
        .from('machines')
        .select('id, name, locations(name)')
        .order('name')
      if (machinesError) console.error('Error fetching machines:', machinesError)
      setMachines(machinesData || [])

      // Fetch document types
      const { data: docTypesData } = await supabase
        .from('document_types')
        .select('*')
        .eq('is_active', true)
        .order('sort_order')
      setDocumentTypes(docTypesData || [])

      // Fetch routing templates with steps
      const { data: rtData } = await supabase
        .from('routing_templates')
        .select('*, routing_template_steps(*)')
        .eq('is_active', true)
        .order('name')
      setRoutingTemplates((rtData || []).map(t => ({
        ...t,
        routing_template_steps: (t.routing_template_steps || []).sort((a, b) => a.step_order - b.step_order)
      })))

    } catch (err) {
      console.error('Error fetching data:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  const loadInventory = useCallback(async () => {
    try {
      const { data: receiving } = await supabase
        .from('material_receiving')
        .select('id, material_id, material_type, bar_size, bar_length_inches, lot_number, quantity, vendor, rack, received_at, po_number, price_per_bar')
        .order('received_at', { ascending: false })

      const { data: usage } = await supabase
        .from('material_usage')
        .select('material_receiving_id, material_id, lot_number, quantity_used, quantity_used_inches')

      const usageMap = {}
      for (const u of (usage || [])) {
        if (!u.material_receiving_id) continue
        if (!usageMap[u.material_receiving_id]) usageMap[u.material_receiving_id] = { bars: 0, inches: 0 }
        usageMap[u.material_receiving_id].bars += (u.quantity_used || 0)
        usageMap[u.material_receiving_id].inches += (u.quantity_used_inches || 0)
      }

      const rows = (receiving || []).map(r => {
        const used = usageMap[r.id] || { bars: 0, inches: 0 }
        const receivedInches = (r.quantity || 0) * (r.bar_length_inches || 0)
        const availableInches = receivedInches - used.inches
        const availableBars = r.bar_length_inches > 0
          ? availableInches / r.bar_length_inches
          : (r.quantity - used.bars)
        return {
          id: r.id,
          material_type: r.material_type,
          bar_size: r.bar_size,
          lot_number: r.lot_number,
          vendor: r.vendor || '—',
          rack: r.rack || null,
          received_at: r.received_at,
          received_bars: r.quantity,
          received_inches: receivedInches,
          bar_length_inches: r.bar_length_inches,
          used_bars: used.bars,
          used_inches: used.inches,
          available_inches: Math.max(0, availableInches),
          // Signed (unclamped) so negative availability surfaces for chase-down.
          available_bars: availableBars,
          po_number: r.po_number || null,
          price_per_bar: r.price_per_bar != null ? Number(r.price_per_bar) : null,
        }
      })
      setInventoryRows(rows)
    } catch (err) {
      console.error('Error loading inventory:', err)
    }
  }, [])

  // Reconciliation flags raised by the DB trigger (unknown lot / negative inventory).
  const loadReconciliation = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from('material_reconciliation_flags')
        .select('*, jobs:job_id(job_number), resolver:resolved_by(full_name)')
        .order('raised_at', { ascending: false })
      if (error) throw error
      const flags = data || []
      // Attach the linked receipt's PO (audit trail on resolved rows) without
      // depending on a PostgREST FK embed — one batched lookup by receiving id.
      const recvIds = [...new Set(flags.map(f => f.material_receiving_id).filter(Boolean))]
      const poById = {}
      if (recvIds.length > 0) {
        const { data: recs } = await supabase
          .from('material_receiving')
          .select('id, po_number')
          .in('id', recvIds)
        for (const r of (recs || [])) poById[r.id] = r.po_number
      }
      const withPo = flags.map(f => ({
        ...f,
        _linked_po: f.material_receiving_id ? (poById[f.material_receiving_id] || null) : null,
      }))
      setReconFlags(withPo)
      setOpenFlagCount(withPo.filter(f => f.status === 'open').length)
    } catch (err) {
      console.error('Error loading reconciliation flags:', err)
    }
  }, [])

  // Lightweight open-count for the tab badge, loaded on mount without visiting the tab.
  const loadOpenFlagCount = useCallback(async () => {
    try {
      const { count } = await supabase
        .from('material_reconciliation_flags')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open')
      setOpenFlagCount(count || 0)
    } catch (err) {
      console.error('Error loading open flag count:', err)
    }
  }, [])

  const closeResolveModal = () => {
    setResolvingFlag(null)
    setResolutionNotes('')
    setResolveError('')
    setResolveReceipts([])
    setResolveOrphans([])
    setResolveSelectedReceiptId('')
  }

  // Shared link path (Reconciliation Resolve modal AND the receiving-save nudge).
  // Calls the SECURITY DEFINER RPC, refreshes flags + inventory, and raises the
  // non-blocking warning banner when the link over-consumes the receipt.
  const linkUnknownLotUsage = async ({ flagId, receivingId, notes, lotNumber }) => {
    const { data, error } = await supabase.rpc('link_unknown_lot_usage', {
      p_flag_id: flagId,
      p_receiving_id: receivingId,
      p_notes: notes || null,
    })
    if (error) throw error
    await loadReconciliation()
    await loadInventory()
    if (data?.negative_flag_raised) {
      setNegFlagToast(`Linked consumption exceeds receipt — negative inventory flag raised for lot ${lotNumber || ''}.`)
    }
    return data
  }

  // Open the Resolve modal. For an unknown_lot flag (admin/compliance only),
  // preload the matching receipts and the orphaned staging rows for linking.
  const openResolve = async (flag) => {
    setResolvingFlag(flag)
    setResolutionNotes('')
    setResolveError('')
    setResolveReceipts([])
    setResolveOrphans([])
    setResolveSelectedReceiptId('')
    if (canLink && flag.flag_type === 'unknown_lot' && flag.lot_number) {
      setResolveLoading(true)
      try {
        const [{ data: receipts }, { data: orphans }] = await Promise.all([
          supabase
            .from('material_receiving')
            .select('id, po_number, quantity, received_at, material_type, bar_size, vendor')
            .eq('lot_number', flag.lot_number)
            .order('received_at', { ascending: false }),
          supabase
            .from('material_usage')
            .select('id, used_at, quantity_used, job_id, jobs:job_id(job_number)')
            .eq('lot_number', flag.lot_number)
            .is('material_receiving_id', null)
            .order('used_at'),
        ])
        setResolveReceipts(receipts || [])
        setResolveOrphans(orphans || [])
        if ((receipts || []).length === 1) setResolveSelectedReceiptId(receipts[0].id)
      } catch (err) {
        setResolveError('Failed to load linkable receipts: ' + err.message)
      } finally {
        setResolveLoading(false)
      }
    }
  }

  const handleResolveFlag = async (status) => {
    if (!resolvingFlag || !resolutionNotes.trim()) return
    setResolvingSaving(true)
    setResolveError('')
    try {
      const { error } = await supabase
        .from('material_reconciliation_flags')
        .update({
          status,
          resolution_notes: resolutionNotes.trim(),
          resolved_by: profile.id,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', resolvingFlag.id)
      if (error) throw error
      closeResolveModal()
      await loadReconciliation()
    } catch (err) {
      setResolveError('Failed to update flag: ' + err.message)
    } finally {
      setResolvingSaving(false)
    }
  }

  const handleLinkAndResolve = async () => {
    if (!resolvingFlag || !resolveSelectedReceiptId) return
    setResolvingSaving(true)
    setResolveError('')
    try {
      await linkUnknownLotUsage({
        flagId: resolvingFlag.id,
        receivingId: resolveSelectedReceiptId,
        notes: resolutionNotes.trim() || null,
        lotNumber: resolvingFlag.lot_number,
      })
      closeResolveModal()
    } catch (err) {
      setResolveError('Link failed: ' + err.message)
    } finally {
      setResolvingSaving(false)
    }
  }

  // Receiving-save nudge: close out / link the staged material to the new receipt.
  const closeNudge = () => {
    setReceivingNudge(null)
    setNudgeError('')
    setReceivingForm({ material_id: '', vendor: '', po_number: '', lot_number: '', quantity: '', bar_length_inches: '', weight_lbs: '', price_per_lb: '', price_per_bar: '', rack: '', notes: '' })
  }

  const handleNudgeLink = async () => {
    if (!receivingNudge) return
    setNudgeSaving(true)
    setNudgeError('')
    try {
      await linkUnknownLotUsage({
        flagId: receivingNudge.flagId,
        receivingId: receivingNudge.receivingId,
        notes: null,
        lotNumber: receivingNudge.lotNumber,
      })
      closeNudge()
    } catch (err) {
      setNudgeError('Link failed: ' + err.message)
    } finally {
      setNudgeSaving(false)
    }
  }

  useEffect(() => {
    fetchData()
  }, [fetchData])

  useEffect(() => {
    if (activeTab === 'inventory') loadInventory()
  }, [activeTab, loadInventory])

  useEffect(() => {
    if (activeTab === 'reconciliation') { loadReconciliation(); loadInventory() }
  }, [activeTab, loadReconciliation, loadInventory])

  useEffect(() => {
    loadOpenFlagCount()
  }, [loadOpenFlagCount])

  // Filter parts based on search, tab, and active state
  const filteredParts = parts.filter(p => {
    const matchesSearch =
      p.part_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(searchQuery.toLowerCase())

    const matchesActive =
      activeFilter === 'all' ? true :
      activeFilter === 'active' ? p.is_active === true :
      p.is_active === false

    if (!matchesActive) return false

    if (activeTab === 'assemblies') {
      return matchesSearch && (p.part_type === 'assembly' || p.part_type === 'finished_good')
    } else if (activeTab === 'components') {
      return matchesSearch && p.part_type !== 'assembly' && p.part_type !== 'finished_good'
    }
    return matchesSearch
  })

  // When viewing Inactive, surface inactive parts that still have open CO demand
  // at the top — they're the ones blocking real orders. Active filter is untouched.
  const sortedParts = activeFilter === 'inactive'
    ? [...filteredParts].sort((a, b) => {
        const ac = pendingCOByPart[a.id] || 0
        const bc = pendingCOByPart[b.id] || 0
        if (ac !== bc) return bc - ac
        return (a.part_number || '').localeCompare(b.part_number || '')
      })
    : filteredParts

  // SKY16: Helper to compute the default doc requirements for a given part_type.
  // Used by openPartModal (on create) and the Part Type onChange (when user
  // switches type in create mode). Returns [] for non-manufactured types.
  const computeDefaultDocRequirements = (partType) => {
    if (partType !== 'manufactured') return []
    const defaultCodes = ['drawing', 'production_log_blank', 'material_cert']
    return defaultCodes
      .map(code => documentTypes.find(dt => dt.code === code))
      .filter(Boolean)
      .map(dt => ({
        document_type_id: dt.id,
        required_at: 'compliance_review',
        is_required: true,
        notes: ''
      }))
  }

  // Open part modal for create/edit
  const openPartModal = async (part = null) => {
    if (part) {
      setEditingPart(part)
      setPartForm({
        part_number: part.part_number,
        description: part.description || '',
        part_type: part.part_type || 'manufactured',
        customer: part.customer || '',
        specification: part.specification || '',
        requires_passivation: part.requires_passivation || false,
        unit_cost: part.unit_cost || 0,
        material_type_id: part.material_type_id || null,
        drawing_revision: part.drawing_revision || '',
        is_active: part.is_active !== false
      })

      // Load existing routing steps
      const { data: existingSteps } = await supabase
        .from('part_routing_steps')
        .select('*')
        .eq('part_id', part.id)
        .eq('is_active', true)
        .order('step_order')
      setRoutingSteps((existingSteps || []).map(s => ({
        step_name: s.step_name,
        step_type: s.step_type || 'internal',
        default_station: s.default_station || '',
        notes: s.notes || ''
      })))

      // Load existing document requirements
      const { data: existingDocReqs } = await supabase
        .from('part_document_requirements')
        .select('*')
        .eq('part_id', part.id)
      setDocRequirements((existingDocReqs || []).map(r => ({
        document_type_id: r.document_type_id,
        required_at: r.required_at || 'compliance_review',
        is_required: r.is_required !== false,
        notes: r.notes || ''
      })))
      setShowDocRequirements((existingDocReqs || []).length > 0)

      // Load existing machine preferences (both preferred and secondary)
      const { data: prefs } = await supabase
        .from('part_machine_durations')
        .select('machine_id, preference_order, is_preferred')
        .eq('part_id', part.id)
        .order('preference_order')

      if (prefs && prefs.length > 0) {
        const primary = prefs.find(p => p.is_preferred === true && p.preference_order === 0)
        const secondaries = prefs.filter(p => p.is_preferred === false).map(p => p.machine_id)
        setPreferredMachineId(primary?.machine_id || null)
        setSecondaryMachineIds(secondaries)
      } else {
        setPreferredMachineId(null)
        setSecondaryMachineIds([])
      }
    } else {
      setEditingPart(null)
      const newPartType = activeTab === 'assemblies' ? 'assembly' : 'manufactured'
      setPartForm({
        part_number: '',
        description: '',
        part_type: newPartType,
        customer: '',
        specification: '',
        requires_passivation: false,
        unit_cost: 0,
        material_type_id: null,
        drawing_revision: '',
        is_active: true
      })
      setRoutingSteps(
        newPartType === 'assembly'
          ? [{ step_name: 'Assemble', step_type: 'internal', default_station: '', notes: '' }]
          : []
      )

      // SKY16: Pre-populate the 3 standard pre-mfg compliance doc requirements
      // when creating a new manufactured part. User can still edit/add/remove
      // before saving. Other part types start empty.
      const defaults = computeDefaultDocRequirements(newPartType)
      setDocRequirements(defaults)
      setShowDocRequirements(defaults.length > 0)
      setPreferredMachineId(null)
      setSecondaryMachineIds([])
    }
    setShowPartModal(true)
  }

  // Routing step management for part modal
  const addRoutingStep = () => {
    setRoutingSteps([...routingSteps, { step_name: '', step_type: 'internal', default_station: '', notes: '' }])
  }

  const removeRoutingStep = (index) => {
    setRoutingSteps(routingSteps.filter((_, i) => i !== index))
  }

  const moveRoutingStep = (index, direction) => {
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= routingSteps.length) return
    const updated = [...routingSteps]
    const [moved] = updated.splice(index, 1)
    updated.splice(newIndex, 0, moved)
    setRoutingSteps(updated)
  }

  const reorderRoutingSteps = (fromIdx, toIdx) => {
    if (fromIdx === toIdx) return
    const updated = [...routingSteps]
    const [moved] = updated.splice(fromIdx, 1)
    updated.splice(toIdx, 0, moved)
    setRoutingSteps(updated)
  }

  const updateRoutingStep = (index, field, value) => {
    const updated = [...routingSteps]
    updated[index] = { ...updated[index], [field]: value }
    setRoutingSteps(updated)
  }

  const loadRoutingFromTemplate = (templateId) => {
    if (!templateId) return
    const template = routingTemplates.find(t => t.id === templateId)
    if (!template) return
    setRoutingSteps(
      (template.routing_template_steps || [])
        .sort((a, b) => a.step_order - b.step_order)
        .map(s => ({
          step_name: s.step_name,
          step_type: s.step_type || 'internal',
          default_station: s.default_station || '',
          notes: s.notes || ''
        }))
    )
  }

  // Save part
  const handleSavePart = async () => {
    if (!partForm.part_number.trim()) {
      alert('Part number is required')
      return
    }

    // Routing is mandatory for manufactured, assembly, and finished_good parts
    const needsRouting =
      partForm.part_type === 'manufactured' ||
      partForm.part_type === 'finished_good' ||
      partForm.part_type === 'assembly'
    if (needsRouting && routingSteps.length === 0) {
      alert('Routing is required — add at least one step')
      return
    }
    if (needsRouting && routingSteps.some(s => !s.step_name.trim())) {
      alert('All routing steps must have a name')
      return
    }

    // Assembly routes must begin with an internal "Assemble" step
    if (partForm.part_type === 'assembly' && needsRouting && routingSteps.length > 0) {
      const first = routingSteps[0]
      if (first.step_name.trim().toLowerCase() !== 'assemble' || first.step_type !== 'internal') {
        alert('Assembly routes must begin with an internal step named "Assemble".')
        return
      }
    }

    setSaving(true)
    try {
      let partId = editingPart?.id

      if (editingPart) {
        // Update existing
        const { error } = await supabase
          .from('parts')
          .update({
            part_number: partForm.part_number.trim(),
            description: partForm.description.trim() || null,
            part_type: partForm.part_type,
            customer: partForm.customer.trim() || null,
            specification: partForm.specification.trim() || null,
            requires_passivation: partForm.requires_passivation,
            unit_cost: parseFloat(partForm.unit_cost) || 0,
            material_type_id: partForm.material_type_id || null,
            drawing_revision: partForm.drawing_revision?.trim() || null,
            is_active: partForm.is_active,
            updated_at: new Date().toISOString()
          })
          .eq('id', editingPart.id)

        if (error) throw error
      } else {
        // Create new
        const { data: newPart, error } = await supabase
          .from('parts')
          .insert({
            part_number: partForm.part_number.trim(),
            description: partForm.description.trim() || null,
            part_type: partForm.part_type,
            customer: partForm.customer.trim() || null,
            specification: partForm.specification.trim() || null,
            requires_passivation: partForm.requires_passivation,
            unit_cost: parseFloat(partForm.unit_cost) || 0,
            material_type_id: partForm.material_type_id || null,
            drawing_revision: partForm.drawing_revision?.trim() || null,
            is_active: partForm.is_active
          })
          .select()
          .single()

        if (error) throw error
        partId = newPart.id
      }

      // Save machine preferences (only for manufactured/finished_good parts)
      if (partId && partForm.part_type !== 'purchased') {
        // Delete ALL existing preferences for this part before re-insert
        await supabase
          .from('part_machine_durations')
          .delete()
          .eq('part_id', partId)

        // Insert preferred machine
        if (preferredMachineId) {
          await supabase
            .from('part_machine_durations')
            .insert({
              part_id: partId,
              machine_id: preferredMachineId,
              is_preferred: true,
              preference_order: 0,
              estimated_minutes: null
            })
        }

        // Insert secondary machines
        for (let i = 0; i < secondaryMachineIds.length; i++) {
          if (secondaryMachineIds[i]) {
            await supabase
              .from('part_machine_durations')
              .insert({
                part_id: partId,
                machine_id: secondaryMachineIds[i],
                is_preferred: false,
                preference_order: i + 1,
                estimated_minutes: null
              })
          }
        }
      }

      // Save routing steps (for manufactured/finished_good)
      if (partId && needsRouting && routingSteps.length > 0) {
        // Delete existing steps and re-insert (simplest for reorder support)
        await supabase.from('part_routing_steps').delete().eq('part_id', partId)
        for (let i = 0; i < routingSteps.length; i++) {
          await supabase.from('part_routing_steps').insert({
            part_id: partId,
            step_order: i + 1,
            step_name: routingSteps[i].step_name.trim(),
            step_type: routingSteps[i].step_type,
            default_station: routingSteps[i].default_station?.trim() || null,
            notes: routingSteps[i].notes?.trim() || null
          })
        }
      }

      // Save document requirements
      if (partId && docRequirements.length > 0) {
        await supabase.from('part_document_requirements').delete().eq('part_id', partId)
        for (const req of docRequirements) {
          if (req.document_type_id) {
            await supabase.from('part_document_requirements').insert({
              part_id: partId,
              document_type_id: req.document_type_id,
              required_at: req.required_at || 'compliance_review',
              is_required: req.is_required !== false,
              notes: req.notes?.trim() || null
            })
          }
        }
      } else if (partId && docRequirements.length === 0 && editingPart) {
        // If all requirements were removed, delete existing
        await supabase.from('part_document_requirements').delete().eq('part_id', partId)
      }

      setShowPartModal(false)
      setEditingPart(null)
      await fetchData()
    } catch (err) {
      console.error('Error saving part:', err)
      alert('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // Delete part (soft delete)
  const handleDeletePart = async (partId) => {
    if (!confirm('Are you sure you want to delete this part?')) return
    
    setDeleting(partId)
    try {
      const { error } = await supabase
        .from('parts')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', partId)

      if (error) throw error
      await fetchData()
    } catch (err) {
      console.error('Error deleting part:', err)
      alert('Failed to delete: ' + err.message)
    } finally {
      setDeleting(null)
    }
  }

  // Open BOM modal
  const openBOMModal = (assembly) => {
    setSelectedAssembly(assembly)
    setBomComponents(assembly.assembly_bom || [])
    // Get available components (non-assembly parts)
    setAvailableComponents(parts.filter(p => p.part_type !== 'assembly' && p.part_type !== 'finished_good' && p.id !== assembly.id))
    setShowBOMModal(true)
  }

  // Keep the BOM modal in sync with the latest parts data so component edits
  // (especially is_active flips) are reflected without closing the modal.
  useEffect(() => {
    if (!showBOMModal || !selectedAssembly) return
    const refreshed = parts.find(p => p.id === selectedAssembly.id)
    if (refreshed) {
      setSelectedAssembly(refreshed)
      setBomComponents(refreshed.assembly_bom || [])
    }
  }, [parts, showBOMModal, selectedAssembly?.id])

  // Add component to BOM
  const addToBOM = async (componentId) => {
    if (!selectedAssembly) return
    
    setSaving(true)
    try {
      const { error } = await supabase
        .from('assembly_bom')
        .insert({
          assembly_id: selectedAssembly.id,
          component_id: componentId,
          quantity: 1,
          sort_order: bomComponents.length
        })

      if (error) throw error
      
      // Refresh data
      await fetchData()
      // Update local state
      const updated = parts.find(p => p.id === selectedAssembly.id)
      if (updated) {
        setSelectedAssembly(updated)
        setBomComponents(updated.assembly_bom || [])
      }
    } catch (err) {
      console.error('Error adding to BOM:', err)
      alert('Failed to add component: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // Update BOM quantity
  const updateBOMQuantity = async (bomId, quantity) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('assembly_bom')
        .update({ quantity: parseInt(quantity) || 1 })
        .eq('id', bomId)

      if (error) throw error
      
      // Update local state
      setBomComponents(prev => prev.map(b => 
        b.id === bomId ? { ...b, quantity: parseInt(quantity) || 1 } : b
      ))
    } catch (err) {
      console.error('Error updating BOM:', err)
    } finally {
      setSaving(false)
    }
  }

  // Remove from BOM
  const removeFromBOM = async (bomId) => {
    setSaving(true)
    try {
      const { error } = await supabase
        .from('assembly_bom')
        .delete()
        .eq('id', bomId)

      if (error) throw error
      
      setBomComponents(prev => prev.filter(b => b.id !== bomId))
      await fetchData()
    } catch (err) {
      console.error('Error removing from BOM:', err)
      alert('Failed to remove: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  // Material type handlers
  const openMaterialModal = (material = null) => {
    if (material) {
      setEditingMaterial(material)
      setMaterialForm({
        name: material.name,
        short_code: material.short_code || '',
        category: material.category || ''
      })
    } else {
      setEditingMaterial(null)
      setMaterialForm({ name: '', short_code: '', category: '' })
    }
    setShowMaterialModal(true)
  }

  const handleSaveMaterial = async () => {
    if (!materialForm.name.trim()) {
      alert('Material name is required')
      return
    }

    setSaving(true)
    try {
      if (editingMaterial) {
        const { error } = await supabase
          .from('material_types')
          .update({
            name: materialForm.name.trim(),
            short_code: materialForm.short_code.trim() || null,
            category: materialForm.category.trim() || null
          })
          .eq('id', editingMaterial.id)

        if (error) throw error
      } else {
        const { error } = await supabase
          .from('material_types')
          .insert({
            name: materialForm.name.trim(),
            short_code: materialForm.short_code.trim() || null,
            category: materialForm.category.trim() || null
          })

        if (error) throw error
      }

      setShowMaterialModal(false)
      setEditingMaterial(null)
      await fetchData()
    } catch (err) {
      console.error('Error saving material:', err)
      alert('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteMaterial = async (materialId) => {
    if (!confirm('Are you sure you want to delete this material type?')) return
    
    setDeleting(materialId)
    try {
      const { error } = await supabase
        .from('material_types')
        .update({ is_active: false })
        .eq('id', materialId)

      if (error) throw error
      await fetchData()
    } catch (err) {
      console.error('Error deleting material:', err)
      alert('Failed to delete: ' + err.message)
    } finally {
      setDeleting(null)
    }
  }

  // Bar size handlers
  const openBarSizeModal = (barSize = null) => {
    if (barSize) {
      setEditingBarSize(barSize)
      setBarSizeForm({
        size: barSize.size,
        size_decimal: barSize.size_decimal?.toString() || '',
        shape: barSize.shape || 'round'
      })
    } else {
      setEditingBarSize(null)
      setBarSizeForm({ size: '', size_decimal: '', shape: 'round' })
    }
    setShowBarSizeModal(true)
  }

  const handleSaveBarSize = async () => {
    if (!barSizeForm.size.trim()) {
      alert('Size is required')
      return
    }

    setSaving(true)
    try {
      if (editingBarSize) {
        const { error } = await supabase
          .from('bar_sizes')
          .update({
            size: barSizeForm.size.trim(),
            size_decimal: parseFloat(barSizeForm.size_decimal) || null,
            shape: barSizeForm.shape
          })
          .eq('id', editingBarSize.id)

        if (error) throw error
      } else {
        const { error } = await supabase
          .from('bar_sizes')
          .insert({
            size: barSizeForm.size.trim(),
            size_decimal: parseFloat(barSizeForm.size_decimal) || null,
            shape: barSizeForm.shape
          })

        if (error) throw error
      }

      setShowBarSizeModal(false)
      setEditingBarSize(null)
      await fetchData()
    } catch (err) {
      console.error('Error saving bar size:', err)
      alert('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteBarSize = async (barSizeId) => {
    if (!confirm('Are you sure you want to delete this bar size?')) return
    
    setDeleting(barSizeId)
    try {
      const { error } = await supabase
        .from('bar_sizes')
        .update({ is_active: false })
        .eq('id', barSizeId)

      if (error) throw error
      await fetchData()
    } catch (err) {
      console.error('Error deleting bar size:', err)
      alert('Failed to delete: ' + err.message)
    } finally {
      setDeleting(null)
    }
  }

  const handleSaveMaterialMaster = async () => {
    setSaving(true)
    setMaterialModalError('')
    setExistingInactive(null)
    try {
      const vendorTrim = (materialMasterForm.vendor || '').trim()
      const barSize = parseFloat(materialMasterForm.bar_size_inches)

      // Duplicate check (case-insensitive vendor match; null vendors compared
      // as null). Excludes the row currently being edited.
      let dupQuery = supabase
        .from('materials')
        .select('id, vendor, is_active')
        .eq('material_type_id', materialMasterForm.material_type_id)
        .eq('bar_size_inches', barSize)
      dupQuery = vendorTrim
        ? dupQuery.ilike('vendor', vendorTrim)
        : dupQuery.is('vendor', null)
      if (editingMaterialMaster) {
        dupQuery = dupQuery.neq('id', editingMaterialMaster.id)
      }
      const { data: existing, error: dupErr } = await dupQuery.maybeSingle()
      if (dupErr) throw dupErr

      if (existing) {
        if (existing.is_active) {
          setMaterialModalError('This material/vendor combination already exists and is active.')
          return
        }
        setExistingInactive(existing)
        return
      }

      const payload = {
        material_type_id: materialMasterForm.material_type_id,
        bar_size_inches: barSize,
        density_lbs_per_cubic_inch: materialMasterForm.density_lbs_per_cubic_inch
          ? parseFloat(materialMasterForm.density_lbs_per_cubic_inch) : null,
        vendor: vendorTrim || null,
        notes: materialMasterForm.notes?.trim() || null,
        updated_at: new Date().toISOString()
      }
      if (editingMaterialMaster) {
        const { error } = await supabase
          .from('materials')
          .update(payload)
          .eq('id', editingMaterialMaster.id)
        if (error) throw error
      } else {
        const { error } = await supabase
          .from('materials')
          .insert({ ...payload, is_active: true })
        if (error) throw error
      }
      setShowMaterialMasterModal(false)
      setEditingMaterialMaster(null)
      setMaterialMasterForm({ material_type_id: '', bar_size_inches: '', density_lbs_per_cubic_inch: '', vendor: '', notes: '' })
      await fetchData()
    } catch (err) {
      setMaterialModalError('Error saving material: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleToggleMaterialActive = async (material) => {
    try {
      const { error } = await supabase
        .from('materials')
        .update({ is_active: !material.is_active, updated_at: new Date().toISOString() })
        .eq('id', material.id)
      if (error) throw error
      await fetchData()
    } catch (err) {
      alert('Failed to toggle material: ' + err.message)
    }
  }

  const handleReactivateExisting = async () => {
    if (!existingInactive) return
    setSaving(true)
    try {
      const { error } = await supabase
        .from('materials')
        .update({ is_active: true, updated_at: new Date().toISOString() })
        .eq('id', existingInactive.id)
      if (error) throw error
      setShowMaterialMasterModal(false)
      setEditingMaterialMaster(null)
      setExistingInactive(null)
      setMaterialModalError('')
      setMaterialMasterForm({ material_type_id: '', bar_size_inches: '', density_lbs_per_cubic_inch: '', vendor: '', notes: '' })
      await fetchData()
    } catch (err) {
      setMaterialModalError('Failed to reactivate: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteMaterialMaster = async () => {
    if (!materialToDelete) return
    setDeleting(materialToDelete.id)
    try {
      const { error } = await supabase
        .from('materials')
        .delete()
        .eq('id', materialToDelete.id)
      if (error) throw error
      setMaterialToDelete(null)
      await fetchData()
    } catch (err) {
      alert('Failed to delete material: ' + err.message)
    } finally {
      setDeleting(null)
    }
  }

  // Refresh the per-row cert counts after an upload/delete (single batched query).
  const refreshDocCounts = async () => {
    try {
      const { data } = await supabase.from('material_documents').select('material_receiving_id')
      const counts = {}
      for (const d of (data || [])) {
        if (d.material_receiving_id) counts[d.material_receiving_id] = (counts[d.material_receiving_id] || 0) + 1
      }
      setMaterialDocCounts(counts)
    } catch (err) {
      console.error('Failed to refresh doc counts:', err)
    }
  }

  // Open the Lot Documents modal for an inventory/receiving row and load its docs.
  const openLotDocs = async (receivingRow) => {
    setDocsModalRow(receivingRow)
    setDocModalError('')
    setLotDocs([])
    setLotDocsLoading(true)
    try {
      const { data, error } = await supabase
        .from('material_documents')
        .select('*, uploader:uploaded_by(full_name)')
        .eq('material_receiving_id', receivingRow.id)
        .order('uploaded_at', { ascending: false })
      if (error) throw error
      setLotDocs(data || [])
    } catch (err) {
      setDocModalError('Failed to load documents: ' + err.message)
    } finally {
      setLotDocsLoading(false)
    }
  }

  const handleLotDocUpload = async (files) => {
    if (!docsModalRow || !files || files.length === 0) return
    setDocUploading(true)
    setDocModalError('')
    try {
      for (const file of files) {
        const up = await uploadDocument(file, `material-certs/${docsModalRow.id}`)
        const { error } = await supabase.from('material_documents').insert({
          material_receiving_id: docsModalRow.id,
          document_type: 'material_cert',
          file_name: up.fileName,
          file_path: up.filePath,
          file_size: up.fileSize,
          mime_type: up.mimeType,
          uploaded_by: profile.id,
        })
        if (error) throw error
      }
      await openLotDocs(docsModalRow)
      await refreshDocCounts()
    } catch (err) {
      setDocModalError('Upload failed: ' + err.message)
    } finally {
      setDocUploading(false)
    }
  }

  const handleDeleteLotDoc = async (doc) => {
    if (!confirm(`Delete ${doc.file_name}?`)) return
    try {
      await deleteDocument(doc.file_path)
      const { error } = await supabase.from('material_documents').delete().eq('id', doc.id)
      if (error) throw error
      setLotDocs(prev => prev.filter(d => d.id !== doc.id))
      await refreshDocCounts()
    } catch (err) {
      setDocModalError('Delete failed: ' + err.message)
    }
  }

  const handleViewDoc = async (filePath) => {
    try {
      const url = await getDocumentUrl(filePath)
      if (url) window.open(url, '_blank')
    } catch (err) {
      alert('Failed to open document: ' + err.message)
    }
  }

  // Full reset + close for the receiving modal (shared by X / Cancel / Close).
  const closeReceivingModal = () => {
    setShowReceivingModal(false)
    setReceivingError('')
    setReceivingCertFiles([])
    setReceivingTypeId('')
    setReceivingSize('')
    setSavedReceiptId(null)
  }

  const handleSaveReceiving = async () => {
    // Vendor + PO are mandatory for every receipt (pricing/traceability).
    if (!receivingForm.vendor.trim() || !receivingForm.po_number.trim()) {
      setReceivingError('Vendor and PO number are required for all receipts.')
      return
    }
    setReceivingError('')
    setSaving(true)
    try {
      const selectedMaterial = materials.find(m => m.id === receivingForm.material_id)

      // BUG FIX: both kiosks match material_usage against material_receiving.bar_size
      // using the bar_sizes.size format (e.g. "0.375 dia"), so writing `0.375"` here
      // orphaned Armory receipts from kiosk checkouts. Resolve the catalog `size`
      // string by decimal match; fall back to a "<decimal> dia" string if unmatched.
      let barSizeStr = null
      if (selectedMaterial) {
        const match = barSizes.find(
          bs => Number(bs.size_decimal) === Number(selectedMaterial.bar_size_inches)
        )
        barSizeStr = match ? match.size : `${selectedMaterial.bar_size_inches} dia`
      }

      const { data: newRow, error } = await supabase
        .from('material_receiving')
        .insert({
          material_id: receivingForm.material_id,
          material_type: selectedMaterial?.material_type?.name || '',
          bar_size: barSizeStr,
          bar_length_inches: parseFloat(receivingForm.bar_length_inches),
          lot_number: receivingForm.lot_number,
          quantity: parseInt(receivingForm.quantity),
          vendor: receivingForm.vendor,
          po_number: receivingForm.po_number.trim(),
          weight_lbs: receivingForm.weight_lbs ? parseFloat(receivingForm.weight_lbs) : null,
          price_per_lb: receivingForm.price_per_lb ? parseFloat(receivingForm.price_per_lb) : null,
          price_per_bar: receivingForm.price_per_bar ? parseFloat(receivingForm.price_per_bar) : null,
          rack: receivingForm.rack || null,
          notes: receivingForm.notes?.trim() || null,
          received_by: profile.id,
          received_at: new Date().toISOString()
        })
        .select()
        .single()
      if (error) throw error

      // Upload any attached material certs. A failed cert must NOT lose the receipt —
      // catch per-file, then surface a retry hint while keeping the receipt saved.
      let certFailed = false
      for (const file of receivingCertFiles) {
        try {
          const up = await uploadDocument(file, `material-certs/${newRow.id}`)
          const { error: docErr } = await supabase.from('material_documents').insert({
            material_receiving_id: newRow.id,
            document_type: 'material_cert',
            file_name: up.fileName,
            file_path: up.filePath,
            file_size: up.fileSize,
            mime_type: up.mimeType,
            uploaded_by: profile.id,
          })
          if (docErr) throw docErr
        } catch (uploadErr) {
          console.error('Cert upload failed (receipt already saved):', uploadErr)
          certFailed = true
        }
      }

      await fetchData()
      if (certFailed) {
        // Keep modal open; guard re-save by switching the footer to a Close action.
        setSavedReceiptId(newRow.id)
        setReceivingCertFiles([])
        setReceivingError('Receipt saved, but cert upload failed — retry from the Inventory tab')
      } else {
        // Link nudge: if this lot already has staged material under an open
        // unknown_lot flag, offer to link it to the receipt we just created.
        const savedLot = receivingForm.lot_number
        let nudged = false
        if (canLink && savedLot) {
          const { data: openFlags } = await supabase
            .from('material_reconciliation_flags')
            .select('id, lot_number')
            .eq('lot_number', savedLot)
            .eq('flag_type', 'unknown_lot')
            .eq('status', 'open')
            .limit(1)
          const flag = (openFlags || [])[0]
          if (flag) {
            const { data: orphans } = await supabase
              .from('material_usage')
              .select('quantity_used, job_id, jobs:job_id(job_number)')
              .eq('lot_number', savedLot)
              .is('material_receiving_id', null)
              .order('used_at')
            const totalBars = (orphans || []).reduce((sum, o) => sum + (o.quantity_used || 0), 0)
            setReceivingNudge({
              flagId: flag.id,
              receivingId: newRow.id,
              lotNumber: savedLot,
              totalBars,
              events: (orphans || []).length,
              sampleJob: (orphans || [])[0]?.jobs?.job_number || null,
            })
            // Hide the form modal; the nudge modal takes over (form not yet reset).
            setShowReceivingModal(false)
            setReceivingError('')
            setReceivingCertFiles([])
            setReceivingTypeId('')
            setReceivingSize('')
            setSavedReceiptId(null)
            nudged = true
          }
        }
        if (!nudged) {
          closeReceivingModal()
          setReceivingForm({ material_id: '', vendor: '', po_number: '', lot_number: '', quantity: '', bar_length_inches: '', weight_lbs: '', price_per_lb: '', price_per_bar: '', rack: '', notes: '' })
        }
      }
    } catch (err) {
      alert('Error saving receiving entry: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleAssignRack = async (receivingId, newRack) => {
    try {
      await supabase
        .from('material_receiving')
        .update({ rack: newRack || null })
        .eq('id', receivingId)
      setAssigningRack(null)
      await loadInventory()
    } catch (err) {
      console.error('Failed to assign rack:', err)
    }
  }

  const cmpSize = (x, y) => {
    const xn = parseFloat(x), yn = parseFloat(y)
    if (!isNaN(xn) && !isNaN(yn)) return xn - yn
    return (x || '').toString().localeCompare((y || '').toString())
  }
  const toggleInvSort = (key) => {
    if (invSortKey === key) setInvSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setInvSortKey(key); setInvSortDir('asc') }
  }

  const filteredInventoryRows = inventoryRows
    .filter(r => {
      if (invFilterMaterial && r.material_type !== invFilterMaterial) return false
      if (invFilterRack === 'Staging' && r.rack !== null) return false
      if (invFilterRack && invFilterRack !== 'Staging' && r.rack !== invFilterRack) return false
      if (invFilterVendor && r.vendor !== invFilterVendor) return false
      if (invFilterSize && r.bar_size !== invFilterSize) return false
      if (invSearchLot && !(r.lot_number || '').toLowerCase().includes(invSearchLot.toLowerCase())) return false
      return true
    })
    .sort((a, b) => {
      const dir = invSortDir === 'desc' ? -1 : 1
      let primary = 0
      if (invSortKey === 'available_bars') primary = (a.available_bars ?? 0) - (b.available_bars ?? 0)
      else if (invSortKey === 'bar_size') primary = cmpSize(a.bar_size, b.bar_size)
      else if (invSortKey === 'lot_number') primary = (a.lot_number || '').localeCompare(b.lot_number || '')
      else primary = (a.material_type || '').localeCompare(b.material_type || '')
      if (primary !== 0) return primary * dir
      // Stable secondary ordering (not reversed): type, then size, then lot.
      return (a.material_type || '').localeCompare(b.material_type || '')
        || cmpSize(a.bar_size, b.bar_size)
        || (a.lot_number || '').localeCompare(b.lot_number || '')
    })

  // Materials (Raw Material master) tab — filtered + default-sorted (type, then size).
  const matFilterActive = !!(matFilterType || matFilterVendor || matFilterSize)
  const filteredMaterials = materials
    .filter(m => {
      if (matFilterType && (m.material_type?.name || '') !== matFilterType) return false
      if (matFilterVendor && (m.vendor || '') !== matFilterVendor) return false
      if (matFilterSize && String(m.bar_size_inches) !== matFilterSize) return false
      return true
    })
    .sort((a, b) => {
      const t = (a.material_type?.name || '').localeCompare(b.material_type?.name || '')
      if (t !== 0) return t
      return Number(a.bar_size_inches) - Number(b.bar_size_inches)
    })

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-skynet-accent" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Non-blocking warning banner (e.g. link raised a negative inventory flag) */}
      {negFlagToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[70] max-w-lg px-4 py-3 bg-red-900/90 border border-red-600 rounded-lg text-sm text-red-100 shadow-lg flex items-center gap-3">
          <AlertTriangle size={16} className="flex-shrink-0" />
          <span>{negFlagToast}</span>
          <button onClick={() => setNegFlagToast('')} className="text-red-200 hover:text-white flex-shrink-0">
            <X size={16} />
          </button>
        </div>
      )}
      {/* Header */}
      <div className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Database className="text-skynet-accent" size={28} />
              <div>
                <h1 className="text-xl font-bold">Armory</h1>
                <p className="text-gray-500 text-sm">The Skybolt parts, materials, and configuration registry</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-800 bg-gray-900/50">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex gap-1">
            {(() => {
              // Round B will add 'replenishment' to this group — single-line change.
              const RAW_MATERIALS_TAB_IDS = ['barsizes', 'material_master', 'inventory', 'reconciliation', 'receiving']
              const allTabs = [
                { id: 'assemblies', label: 'Products', icon: Package, count: parts.filter(p => (p.part_type === 'assembly' || p.part_type === 'finished_good') && (activeFilter === 'all' || (activeFilter === 'active' ? p.is_active : !p.is_active))).length },
                { id: 'components', label: 'Parts', icon: Wrench, count: parts.filter(p => p.part_type !== 'assembly' && p.part_type !== 'finished_good' && (activeFilter === 'all' || (activeFilter === 'active' ? p.is_active : !p.is_active))).length },
                { id: 'materials', label: 'Materials', icon: Layers, count: null },
                { id: 'routing', label: 'Routing Templates', icon: Route, count: null },
                { id: 'barsizes', label: 'Bar Sizes', icon: Database, count: null },
                { id: 'material_master', label: 'RM Master Data', icon: Layers, count: null },
                { id: 'inventory', label: 'Inventory', icon: BarChart2, count: inventoryRows.filter(r => !r.rack).length || null },
                { id: 'reconciliation', label: 'Reconciliation', icon: AlertTriangle, count: openFlagCount || null },
                { id: 'receiving', label: 'Receiving', icon: PackageCheck, count: null },
                { id: 'customers', label: 'Customers', icon: Users, count: null },
                { id: 'users', label: 'Users', icon: Users, count: null },
              ]
              const topLevel = allTabs.filter(t => !RAW_MATERIALS_TAB_IDS.includes(t.id) && canSeeTab(t.id))
              const grouped = allTabs.filter(t => RAW_MATERIALS_TAB_IDS.includes(t.id) && canSeeTab(t.id))
              const groupActive = grouped.some(t => t.id === activeTab)
              const groupCount = grouped.reduce((s, t) => s + (t.count > 0 ? t.count : 0), 0)
              const beforeGroup = topLevel.filter(t => t.id !== 'customers' && t.id !== 'users')
              const afterGroup = topLevel.filter(t => t.id === 'customers' || t.id === 'users')
              const renderTopBtn = (t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveTab(t.id)}
                  className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTab === t.id ? 'border-skynet-accent text-skynet-accent' : 'border-transparent text-gray-400 hover:text-white'
                  }`}
                >
                  <t.icon size={16} />
                  {t.label}
                  {t.count > 0 && (
                    <span className={`px-1.5 py-0.5 text-xs rounded ${activeTab === t.id ? 'bg-skynet-accent/20' : 'bg-gray-800'}`}>{t.count}</span>
                  )}
                </button>
              )
              return (
                <>
                  {beforeGroup.map(renderTopBtn)}
                  {grouped.length > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => setRawMenuOpen(o => !o)}
                        className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                          groupActive ? 'border-skynet-accent text-skynet-accent' : 'border-transparent text-gray-400 hover:text-white'
                        }`}
                      >
                        <Layers size={16} />
                        Raw Materials
                        {groupCount > 0 && (
                          <span className={`px-1.5 py-0.5 text-xs rounded ${groupActive ? 'bg-skynet-accent/20' : 'bg-gray-800'}`}>{groupCount}</span>
                        )}
                        <ChevronDown size={14} className={`transition-transform ${rawMenuOpen ? 'rotate-180' : ''}`} />
                      </button>
                      {rawMenuOpen && (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setRawMenuOpen(false)} />
                          <div className="absolute left-0 top-full z-50 w-56 bg-gray-900 border border-gray-700 rounded-b-lg shadow-xl py-1">
                            {grouped.map(t => (
                              <button
                                key={t.id}
                                onClick={() => { setActiveTab(t.id); setRawMenuOpen(false) }}
                                className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                                  activeTab === t.id ? 'text-skynet-accent bg-skynet-accent/10' : 'text-gray-300 hover:text-white hover:bg-gray-800'
                                }`}
                              >
                                <t.icon size={16} />
                                <span className="flex-1 text-left">{t.label}</span>
                                {t.count > 0 && (
                                  <span className="px-1.5 py-0.5 text-xs rounded bg-gray-800">{t.count}</span>
                                )}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                  {afterGroup.map(renderTopBtn)}
                </>
              )
            })()}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-7xl mx-auto px-6 py-6">
        {/* Assemblies / Components Tab */}
        {(activeTab === 'assemblies' || activeTab === 'components') && (
          <div className="space-y-4">
            {/* Toolbar */}
            <div className="flex items-center justify-between gap-4">
              <div className="relative flex-1 max-w-md">
                <Search size={18} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search parts..."
                  className="w-full pl-10 pr-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                />
              </div>
              <div className="flex items-center gap-1 bg-gray-800 border border-gray-700 rounded-lg p-1">
                {[
                  { value: 'active', label: 'Active' },
                  { value: 'inactive', label: 'Inactive', countKey: 'inactive' },
                  { value: 'all', label: 'All' }
                ].map(opt => {
                  const inactiveCount = parts.filter(p => !p.is_active).length
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setActiveFilter(opt.value)}
                      className={`px-3 py-1 text-sm rounded transition-colors ${
                        activeFilter === opt.value
                          ? 'bg-skynet-accent text-white'
                          : 'text-gray-400 hover:text-white hover:bg-gray-700'
                      }`}
                    >
                      {opt.label}
                      {opt.value === 'inactive' && inactiveCount > 0 && (
                        <span className={`ml-1.5 px-1.5 py-0.5 text-xs rounded ${
                          activeFilter === opt.value ? 'bg-blue-700' : 'bg-amber-900/50 text-amber-300'
                        }`}>{inactiveCount}</span>
                      )}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-2">
                {activeTab === 'assemblies' && canWrite && (
                  <button
                    onClick={() => setShowBOMUpload(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-green-700 hover:bg-green-600 text-white font-medium rounded-lg transition-colors"
                  >
                    <Upload size={18} />
                    Upload BOM
                  </button>
                )}
                {canWrite && (
                  <button
                    onClick={() => openPartModal()}
                    className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded-lg transition-colors"
                  >
                    <Plus size={18} />
                    Add {activeTab === 'assemblies' ? 'Product' : 'Part'}
                  </button>
                )}
              </div>
            </div>

            {/* Parts List */}
            {sortedParts.length === 0 ? (
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
                <Package size={48} className="mx-auto text-gray-600 mb-3" />
                <p className="text-gray-400">No {activeTab} found</p>
                <p className="text-gray-600 text-sm mt-1">Click "Add" to create one</p>
              </div>
            ) : (
              <div className="space-y-2">
                {sortedParts.map(part => (
                  <div
                    key={part.id}
                    className={`rounded-lg p-4 transition-colors ${
                      part.is_active
                        ? 'border bg-gray-800/50 border-gray-700 hover:border-gray-600'
                        : (pendingCOByPart[part.id] || 0) > 0
                          ? 'border-2 bg-gray-800/60 border-purple-500 hover:border-purple-400 shadow-lg shadow-purple-900/30'
                          : 'border bg-gray-900/40 border-amber-900/30 hover:border-amber-800/50 opacity-75'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-skynet-accent font-mono font-medium">{part.part_number}</span>
                          {!part.is_active && (
                            <span className="text-xs px-2 py-0.5 bg-amber-900/50 text-amber-300 rounded border border-amber-700/50">Inactive — Pending Master Data</span>
                          )}
                          {!part.is_active && (pendingCOByPart[part.id] || 0) > 0 && (
                            <span className="text-xs px-2 py-0.5 bg-purple-900/50 text-purple-300 rounded border border-purple-700/50">
                              {pendingCOByPart[part.id]} pending CO{pendingCOByPart[part.id] === 1 ? '' : 's'}
                            </span>
                          )}
                          {part.part_type === 'assembly' && (
                            <span className="text-xs px-2 py-0.5 bg-purple-900/50 text-purple-300 rounded border border-purple-700/50">Product (Assembly)</span>
                          )}
                          {part.part_type === 'finished_good' && (
                            <span className="text-xs px-2 py-0.5 bg-emerald-900/50 text-emerald-300 rounded border border-emerald-700/50">Finished Good</span>
                          )}
                          {part.requires_passivation && (
                            <span className="text-xs px-2 py-0.5 bg-cyan-900/50 text-cyan-300 rounded flex items-center gap-1">
                              <Beaker size={10} />
                              Finishing
                            </span>
                          )}
                          {part.part_type === 'purchased' && (
                            <span className="text-xs px-2 py-0.5 bg-orange-900/50 text-orange-300 rounded border border-orange-700/50 flex items-center gap-1">
                              📦 Part (Purchased)
                            </span>
                          )}
                        </div>
                        <p className="text-gray-400 text-sm">{part.description || 'No description'}</p>
                        {part.customer && (
                          <p className="text-gray-500 text-xs mt-1">Customer: {part.customer}</p>
                        )}
                        
                        {/* BOM preview for assemblies only */}
                        {part.part_type === 'assembly' && part.assembly_bom?.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-gray-700">
                            <p className="text-gray-500 text-xs mb-1">
                              BOM Parts ({part.assembly_bom.length}):
                            </p>
                            <div className="flex flex-wrap gap-1">
                              {part.assembly_bom.slice(0, 5).map(bom => (
                                <span key={bom.id} className="text-xs px-2 py-0.5 bg-gray-700 text-gray-300 rounded">
                                  {bom.component?.part_number} ×{bom.quantity}
                                </span>
                              ))}
                              {part.assembly_bom.length > 5 && (
                                <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-400 rounded">
                                  +{part.assembly_bom.length - 5} more
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Info line for finished goods */}
                        {part.part_type === 'finished_good' && (
                          <p className="text-emerald-500/60 text-xs mt-1">No assembly required — ships after post-mfg compliance</p>
                        )}
                      </div>
                      
                      {canWrite && (
                        <div className="flex items-center gap-2">
                          {part.part_type === 'assembly' && (
                            <button
                              onClick={() => openBOMModal(part)}
                              className="p-2 text-purple-400 hover:text-purple-300 hover:bg-purple-900/20 rounded transition-colors"
                              title="Manage BOM"
                            >
                              <Layers size={18} />
                            </button>
                          )}
                          <button
                            onClick={() => openPartModal(part)}
                            className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                            title="Edit"
                          >
                            <Edit2 size={18} />
                          </button>
                          <button
                            onClick={() => handleDeletePart(part.id)}
                            disabled={deleting === part.id}
                            className="p-2 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded transition-colors disabled:opacity-50"
                            title="Delete"
                          >
                            {deleting === part.id ? (
                              <Loader2 size={18} className="animate-spin" />
                            ) : (
                              <Trash2 size={18} />
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Materials Tab */}
        {activeTab === 'materials' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-gray-400">Manage material types for manufacturing tracking</p>
              {canWrite && (
                <button
                  onClick={() => openMaterialModal()}
                  className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded-lg transition-colors"
                >
                  <Plus size={18} />
                  Add Material
                </button>
              )}
            </div>

            {materialTypes.length === 0 ? (
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
                <Layers size={48} className="mx-auto text-gray-600 mb-3" />
                <p className="text-gray-400">No material types defined</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {materialTypes.map(mat => (
                  <div
                    key={mat.id}
                    className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 hover:border-gray-600 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-white font-medium">{mat.name}</p>
                        {mat.short_code && (
                          <p className="text-gray-500 text-sm">Code: {mat.short_code}</p>
                        )}
                        {mat.category && (
                          <p className="text-gray-500 text-xs mt-1">Category: {mat.category}</p>
                        )}
                      </div>
                      {canWrite && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openMaterialModal(mat)}
                            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            onClick={() => handleDeleteMaterial(mat.id)}
                            disabled={deleting === mat.id}
                            className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded disabled:opacity-50"
                          >
                            {deleting === mat.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Bar Sizes Tab */}
        {activeTab === 'barsizes' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-gray-400">Manage standard bar sizes for material tracking</p>
              {canWrite && (
                <button
                  onClick={() => openBarSizeModal()}
                  className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded-lg transition-colors"
                >
                  <Plus size={18} />
                  Add Bar Size
                </button>
              )}
            </div>

            {barSizes.length === 0 ? (
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
                <Database size={48} className="mx-auto text-gray-600 mb-3" />
                <p className="text-gray-400">No bar sizes defined</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
                {barSizes.map(bs => (
                  <div
                    key={bs.id}
                    className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 hover:border-gray-600 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-white font-mono">{bs.size}</p>
                        {bs.size_decimal && (
                          <p className="text-gray-500 text-sm">{bs.size_decimal}" diameter</p>
                        )}
                        <p className="text-gray-600 text-xs capitalize">{bs.shape}</p>
                      </div>
                      {canWrite && (
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => openBarSizeModal(bs)}
                            className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                          >
                            <Edit2 size={14} />
                          </button>
                          <button
                            onClick={() => handleDeleteBarSize(bs.id)}
                            disabled={deleting === bs.id}
                            className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded disabled:opacity-50"
                          >
                            {deleting === bs.id ? (
                              <Loader2 size={14} className="animate-spin" />
                            ) : (
                              <Trash2 size={14} />
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Routing Templates Tab */}
        {activeTab === 'routing' && (
          <RoutingTemplatesTab onDataChange={fetchData} />
        )}

        {/* Material Master Tab */}
        {activeTab === 'material_master' && (
          <div className="space-y-6">

            {/* ── Section 1: Material Definitions ── */}
            <div>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-white">Material Definitions</h2>
                {canSeeTab('material_master') && (
                  <button
                    onClick={() => { setEditingMaterialMaster(null); setMaterialMasterForm({ material_type_id: '', bar_size_inches: '', density_lbs_per_cubic_inch: '', vendor: '', notes: '' }); setMaterialModalError(''); setExistingInactive(null); setShowMaterialMasterModal(true) }}
                    className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-skynet-accent/80 text-white font-medium rounded-lg transition-colors"
                  >
                    <Plus size={18} /> Add Material
                  </button>
                )}
              </div>

              {materials.length === 0 ? (
                <p className="text-gray-400 text-sm">No material definitions yet.</p>
              ) : (
                <>
                {/* Filters */}
                <div className="flex items-center gap-3 flex-wrap mb-3">
                  <select
                    value={matFilterType}
                    onChange={e => setMatFilterType(e.target.value)}
                    className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
                  >
                    <option value="">All Types</option>
                    {[...new Set(materials.map(m => m.material_type?.name).filter(Boolean))].sort().map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                  <select
                    value={matFilterVendor}
                    onChange={e => setMatFilterVendor(e.target.value)}
                    className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
                  >
                    <option value="">All Vendors</option>
                    {[...new Set(materials.map(m => m.vendor).filter(Boolean))].sort().map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                  <select
                    value={matFilterSize}
                    onChange={e => setMatFilterSize(e.target.value)}
                    className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
                  >
                    <option value="">All Sizes</option>
                    {[...new Set(materials.map(m => m.bar_size_inches).filter(s => s != null))]
                      .sort((a, b) => Number(a) - Number(b))
                      .map(s => (<option key={s} value={String(s)}>{s}"</option>))}
                  </select>
                  <span className="text-xs text-gray-500">{filteredMaterials.length} of {materials.length}</span>
                  {matFilterActive && (
                    <button
                      onClick={() => { setMatFilterType(''); setMatFilterVendor(''); setMatFilterSize('') }}
                      className="text-xs text-skynet-accent hover:underline"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div className="overflow-x-auto rounded-lg border border-gray-700">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-800 text-gray-400 uppercase text-xs">
                      <tr>
                        <th className="px-4 py-3 text-left">Material Type</th>
                        <th className="px-4 py-3 text-left">Bar Size (in)</th>
                        <th className="px-4 py-3 text-left">Density (lb/in³)</th>
                        <th className="px-4 py-3 text-left">Vendor</th>
                        <th className="px-4 py-3 text-left">Notes</th>
                        {canSeeTab('material_master') && <th className="px-4 py-3 text-left">Actions</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-700">
                      {filteredMaterials.length === 0 ? (
                        <tr>
                          <td colSpan={canSeeTab('material_master') ? 6 : 5} className="px-4 py-6 text-center text-gray-500 text-sm">
                            No materials match the current filters.
                          </td>
                        </tr>
                      ) : filteredMaterials.map(m => {
                        const refCount = materialRefCounts[m.id] || 0
                        const canDelete = refCount === 0
                        return (
                        <tr key={m.id} className={`bg-gray-900 hover:bg-gray-800 transition-colors ${m.is_active ? '' : 'opacity-50'}`}>
                          <td className="px-4 py-3 text-white font-medium">
                            {m.material_type?.name || '—'}
                            {!m.is_active && (
                              <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400">
                                Inactive
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-gray-300">{m.bar_size_inches}"</td>
                          <td className="px-4 py-3 text-gray-300">{m.density_lbs_per_cubic_inch ?? '—'}</td>
                          <td className="px-4 py-3 text-gray-300">{m.vendor || '—'}</td>
                          <td className="px-4 py-3 text-gray-400 max-w-xs truncate">{m.notes || '—'}</td>
                          {canSeeTab('material_master') && (
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => {
                                    setEditingMaterialMaster(m)
                                    setMaterialMasterForm({
                                      material_type_id: m.material_type_id,
                                      bar_size_inches: String(m.bar_size_inches),
                                      density_lbs_per_cubic_inch: m.density_lbs_per_cubic_inch != null ? String(m.density_lbs_per_cubic_inch) : '',
                                      vendor: m.vendor || '',
                                      notes: m.notes || ''
                                    })
                                    setMaterialModalError('')
                                    setExistingInactive(null)
                                    setShowMaterialMasterModal(true)
                                  }}
                                  className="p-1.5 text-gray-400 hover:text-white rounded transition-colors"
                                  title="Edit"
                                >
                                  <Edit2 size={15} />
                                </button>
                                <button
                                  onClick={() => handleToggleMaterialActive(m)}
                                  className={`p-1.5 rounded transition-colors ${
                                    m.is_active
                                      ? 'text-gray-400 hover:text-red-400 hover:bg-red-900/20'
                                      : 'text-gray-400 hover:text-green-400 hover:bg-green-900/20'
                                  }`}
                                  title={m.is_active ? 'Deactivate' : 'Activate'}
                                >
                                  {m.is_active ? <PowerOff size={15} /> : <Power size={15} />}
                                </button>
                                <button
                                  onClick={() => canDelete && setMaterialToDelete(m)}
                                  disabled={!canDelete}
                                  className={`p-1.5 rounded transition-colors ${
                                    canDelete
                                      ? 'text-gray-400 hover:text-red-400 hover:bg-red-900/20'
                                      : 'text-gray-400 opacity-40 cursor-not-allowed'
                                  }`}
                                  title={canDelete
                                    ? 'Delete'
                                    : `Cannot delete — referenced in ${refCount} record(s). Deactivate instead.`}
                                >
                                  <Trash2 size={15} />
                                </button>
                              </div>
                            </td>
                          )}
                        </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                </>
              )}
            </div>

          </div>
        )}
        {/* Inventory Tab */}
        {activeTab === 'inventory' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-lg font-semibold text-white">Raw Material Inventory</h2>
              <div className="inline-flex rounded-lg border border-gray-700 overflow-hidden">
                <button onClick={() => setInvViewMode('lot')} className={`px-3 py-1.5 text-sm transition-colors ${invViewMode === 'lot' ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'}`}>By Lot</button>
                <button onClick={() => setInvViewMode('size')} className={`px-3 py-1.5 text-sm transition-colors ${invViewMode === 'size' ? 'bg-skynet-accent text-white' : 'text-gray-400 hover:text-white'}`}>By Size</button>
              </div>
            </div>
            {/* Filters */}
            <div className="flex items-center gap-3 flex-wrap">
              <select
                value={invFilterMaterial}
                onChange={e => setInvFilterMaterial(e.target.value)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
              >
                <option value="">All Materials</option>
                {[...new Set(inventoryRows.map(r => r.material_type))].sort().map(mt => (
                  <option key={mt} value={mt}>{mt}</option>
                ))}
              </select>
              <select
                value={invFilterRack}
                onChange={e => setInvFilterRack(e.target.value)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
              >
                <option value="">All Racks</option>
                <option value="Staging">Staging</option>
                <option value="R1">R1</option>
                <option value="R2">R2</option>
                <option value="R3">R3</option>
                <option value="R4">R4</option>
              </select>
              <select
                value={invFilterVendor}
                onChange={e => setInvFilterVendor(e.target.value)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
              >
                <option value="">All Vendors</option>
                {[...new Set(inventoryRows.map(r => r.vendor))].sort().map(v => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
              <select
                value={invFilterSize}
                onChange={e => setInvFilterSize(e.target.value)}
                className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
              >
                <option value="">All Sizes</option>
                {[...new Set(inventoryRows.map(r => r.bar_size).filter(Boolean))]
                  .sort((a, b) => cmpSize(a, b))
                  .map(s => (<option key={s} value={s}>{s}</option>))}
              </select>
              <div className="relative">
                <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500" />
                <input
                  type="text"
                  value={invSearchLot}
                  onChange={e => setInvSearchLot(e.target.value)}
                  placeholder="Search lot #…"
                  className="pl-8 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white text-sm focus:outline-none focus:border-skynet-accent"
                />
              </div>
              {(invFilterMaterial || invFilterRack || invFilterVendor || invFilterSize || invSearchLot) && (
                <button
                  onClick={() => { setInvFilterMaterial(''); setInvFilterRack(''); setInvFilterVendor(''); setInvFilterSize(''); setInvSearchLot('') }}
                  className="text-xs text-skynet-accent hover:underline"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Summary strip */}
            {(() => {
              const totalLots = filteredInventoryRows.length
              const stagingCount = filteredInventoryRows.filter(r => r.rack === null).length
              const lowCount = filteredInventoryRows.filter(r => r.available_bars > 0 && r.available_bars < 2).length
              const outCount = filteredInventoryRows.filter(r => r.available_bars === 0).length
              const negCount = filteredInventoryRows.filter(r => r.available_bars < 0).length
              const totalValue = filteredInventoryRows.reduce((sum, r) => (
                r.price_per_bar != null && r.available_bars > 0
                  ? sum + r.available_bars * r.price_per_bar
                  : sum
              ), 0)
              return (
                <div className="flex items-center gap-3 text-xs text-gray-500">
                  <span>{totalLots} Lots</span>
                  <span className="text-gray-700">·</span>
                  <span className={stagingCount > 0 ? 'text-blue-400' : ''}>{stagingCount} In Staging</span>
                  <span className="text-gray-700">·</span>
                  <span className={lowCount > 0 ? 'text-amber-400' : ''}>{lowCount} Low</span>
                  <span className="text-gray-700">·</span>
                  <span className={outCount > 0 ? 'text-red-400' : ''}>{outCount} Out of Stock</span>
                  <span className="text-gray-700">·</span>
                  <span className={negCount > 0 ? 'text-red-400' : ''}>{negCount} Negative</span>
                  <span className="text-gray-700">·</span>
                  <span>Est. Value ${totalValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
              )
            })()}

            {/* Lot-level table (By Lot view) */}
            {invViewMode === 'lot' && (filteredInventoryRows.length === 0 ? (
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
                <BarChart2 size={48} className="mx-auto text-gray-600 mb-3" />
                <p className="text-gray-400">No inventory records found.</p>
                <p className="text-gray-600 text-sm mt-1">Log receipts in the Receiving tab to populate inventory.</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-700">
                <table className="w-full text-sm">
                  <thead className="bg-gray-800 text-gray-400 uppercase text-xs">
                    <tr>
                      <th className="px-4 py-3 text-left">Rack</th>
                      <th className="px-4 py-3 text-left">
                        <button onClick={() => toggleInvSort('material_type')} className="inline-flex items-center gap-1 uppercase hover:text-white">
                          Material Type
                          {invSortKey === 'material_type' && (invSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-left">
                        <button onClick={() => toggleInvSort('bar_size')} className="inline-flex items-center gap-1 uppercase hover:text-white">
                          Bar Size
                          {invSortKey === 'bar_size' && (invSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-left">
                        <button onClick={() => toggleInvSort('lot_number')} className="inline-flex items-center gap-1 uppercase hover:text-white">
                          Lot #
                          {invSortKey === 'lot_number' && (invSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-left">Vendor</th>
                      <th className="px-4 py-3 text-right">Rec'd</th>
                      <th className="px-4 py-3 text-right">Used</th>
                      <th className="px-4 py-3 text-right">
                        <button onClick={() => toggleInvSort('available_bars')} className="inline-flex items-center gap-1 uppercase hover:text-white">
                          Avail (bars)
                          {invSortKey === 'available_bars' && (invSortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)}
                        </button>
                      </th>
                      <th className="px-4 py-3 text-right">Avail (in)</th>
                      <th className="px-4 py-3 text-right">Est. Value</th>
                      <th className="px-4 py-3 text-center">Docs</th>
                      <th className="px-4 py-3 text-center">Assign</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {filteredInventoryRows.map(row => {
                      const isOut = row.available_bars === 0
                      const isLow = row.available_bars > 0 && row.available_bars < 2
                      const isNeg = row.available_bars < 0
                      const isStaging = row.rack === null
                      const hasBarLength = row.bar_length_inches > 0
                      return (
                        <tr
                          key={row.id}
                          className={`transition-colors ${
                            isOut ? 'bg-red-900/40' : isLow ? 'bg-amber-900/40' : 'bg-gray-900 hover:bg-gray-800'
                          } ${isStaging ? 'border-l-2 border-l-amber-600' : ''}`}
                        >
                          <td className="px-4 py-3">
                            {isStaging ? (
                              <span className="text-xs px-2 py-0.5 bg-amber-900/50 text-amber-300 rounded">Staging</span>
                            ) : (
                              <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-300 rounded">{row.rack}</span>
                            )}
                          </td>
                          <td className={`px-4 py-3 ${isOut ? 'text-gray-500' : 'text-gray-300'}`}>{row.material_type}</td>
                          <td className={`px-4 py-3 ${isOut ? 'text-gray-500' : 'text-gray-300'}`}>{row.bar_size}</td>
                          <td className={`px-4 py-3 font-mono ${isOut ? 'text-gray-500' : 'text-gray-300'}`}>{row.lot_number || '—'}</td>
                          <td className={`px-4 py-3 ${isOut ? 'text-gray-500' : 'text-gray-300'}`}>{row.vendor}</td>
                          <td className={`px-4 py-3 text-right ${isOut ? 'text-gray-500' : 'text-gray-300'}`}>{row.received_bars}</td>
                          <td className={`px-4 py-3 text-right ${isOut ? 'text-gray-500' : 'text-gray-300'}`}>{row.used_bars}</td>
                          <td className={`px-4 py-3 text-right font-mono ${isNeg ? 'text-red-400 font-semibold' : isOut ? 'text-gray-500' : isLow ? 'text-amber-300' : 'text-white'}`}>
                            {hasBarLength ? row.available_bars.toFixed(1) : '—'}
                          </td>
                          <td className={`px-4 py-3 text-right font-mono ${isOut ? 'text-gray-500' : 'text-gray-300'}`}>
                            {hasBarLength ? `${Math.round(row.available_inches).toLocaleString()}"` : '—'}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-gray-300">
                            {row.price_per_bar != null && row.available_bars > 0
                              ? `$${(row.available_bars * row.price_per_bar).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                              : '—'}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <button
                              onClick={() => openLotDocs(row)}
                              className={`inline-flex items-center gap-1 hover:text-skynet-accent ${materialDocCounts[row.id] > 0 ? 'text-skynet-accent' : 'text-gray-600'}`}
                              title="Lot documents"
                            >
                              <Paperclip size={14} />
                              <span className="text-xs">{materialDocCounts[row.id] || 0}</span>
                            </button>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {assigningRack === row.id ? (
                              <div className="flex items-center gap-1 justify-center">
                                <select
                                  value={row.rack || ''}
                                  onChange={e => handleAssignRack(row.id, e.target.value)}
                                  className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-xs focus:outline-none"
                                >
                                  <option value="">Staging</option>
                                  <option value="R1">R1</option>
                                  <option value="R2">R2</option>
                                  <option value="R3">R3</option>
                                  <option value="R4">R4</option>
                                </select>
                                <button
                                  onClick={() => setAssigningRack(null)}
                                  className="text-gray-400 hover:text-white p-0.5"
                                  title="Cancel"
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setAssigningRack(row.id)}
                                className="text-xs px-2 py-1 text-gray-400 hover:text-white hover:bg-gray-700 rounded transition-colors"
                              >
                                <Edit2 size={12} />
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ))}

            {/* Size roll-up (By Size view) */}
            {invViewMode === 'size' && (() => {
              const groups = {}
              for (const r of filteredInventoryRows) {
                const key = `${r.material_type}|||${r.bar_size}`
                if (!groups[key]) groups[key] = { material_type: r.material_type, bar_size: r.bar_size, totalBars: 0, lotCount: 0, vendors: new Set(), value: 0 }
                const g = groups[key]
                g.totalBars += (r.available_bars || 0)
                g.lotCount += 1
                if (r.vendor && r.vendor !== '—') g.vendors.add(r.vendor)
                if (r.price_per_bar != null && r.available_bars > 0) g.value += r.available_bars * r.price_per_bar
              }
              const rows = Object.values(groups).sort((a, b) =>
                (a.material_type || '').localeCompare(b.material_type || '') || cmpSize(a.bar_size, b.bar_size)
              )
              if (rows.length === 0) {
                return (
                  <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
                    <BarChart2 size={48} className="mx-auto text-gray-600 mb-3" />
                    <p className="text-gray-400">No inventory records found.</p>
                  </div>
                )
              }
              const grandBars = rows.reduce((s, g) => s + g.totalBars, 0)
              const grandValue = rows.reduce((s, g) => s + g.value, 0)
              return (
                <div className="overflow-x-auto rounded-lg border border-gray-700">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-800 text-gray-400 uppercase text-xs">
                      <tr>
                        <th className="px-4 py-3 text-left">Material Type</th>
                        <th className="px-4 py-3 text-left">Bar Size</th>
                        <th className="px-4 py-3 text-right">Total Avail (bars)</th>
                        <th className="px-4 py-3 text-right">Lots</th>
                        <th className="px-4 py-3 text-left">Vendors</th>
                        <th className="px-4 py-3 text-right">Est. Value</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-700">
                      {rows.map(g => {
                        const isNeg = g.totalBars < 0
                        return (
                          <tr key={`${g.material_type}|${g.bar_size}`} className="bg-gray-900 hover:bg-gray-800 transition-colors">
                            <td className="px-4 py-3 text-gray-300">{g.material_type}</td>
                            <td className="px-4 py-3 text-gray-300">{g.bar_size}</td>
                            <td className={`px-4 py-3 text-right font-mono ${isNeg ? 'text-red-400 font-semibold' : 'text-white'}`}>{g.totalBars.toFixed(1)}</td>
                            <td className="px-4 py-3 text-right text-gray-400">{g.lotCount}</td>
                            <td className="px-4 py-3 text-gray-400 text-xs">{[...g.vendors].sort().join(', ') || '—'}</td>
                            <td className="px-4 py-3 text-right font-mono text-gray-300">
                              {g.value > 0 ? `$${g.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot className="bg-gray-800/60 text-gray-200 text-xs uppercase">
                      <tr>
                        <td className="px-4 py-3 font-semibold" colSpan={2}>Total ({rows.length} size groups)</td>
                        <td className="px-4 py-3 text-right font-mono font-semibold">{grandBars.toFixed(1)}</td>
                        <td className="px-4 py-3"></td>
                        <td className="px-4 py-3"></td>
                        <td className="px-4 py-3 text-right font-mono font-semibold">
                          {grandValue > 0 ? `$${grandValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )
            })()}
          </div>
        )}

        {/* Reconciliation Tab */}
        {activeTab === 'reconciliation' && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold text-white">Inventory Reconciliation</h2>

            {/* Staging — receipts needing a rack assignment */}
            {(() => {
              const stagingRows = inventoryRows.filter(r => r.rack === null)
              if (stagingRows.length === 0) return null
              return (
                <div className="bg-amber-900/10 border border-amber-800/40 rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <PackageCheck size={16} className="text-amber-400" />
                    <h3 className="text-sm font-semibold text-amber-200">Staging — needs rack assignment ({stagingRows.length})</h3>
                  </div>
                  <div className="overflow-x-auto rounded border border-amber-800/30">
                    <table className="w-full text-sm">
                      <thead className="bg-amber-900/20 text-amber-200/70 uppercase text-xs">
                        <tr>
                          <th className="px-3 py-2 text-left">Material</th>
                          <th className="px-3 py-2 text-left">Bar Size</th>
                          <th className="px-3 py-2 text-left">Lot #</th>
                          <th className="px-3 py-2 text-left">Vendor</th>
                          <th className="px-3 py-2 text-right">Bars</th>
                          <th className="px-3 py-2 text-left">Received</th>
                          <th className="px-3 py-2 text-center">Assign Rack</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-amber-900/20">
                        {stagingRows.map(row => (
                          <tr key={row.id} className="hover:bg-amber-900/10">
                            <td className="px-3 py-2 text-gray-200">{row.material_type}</td>
                            <td className="px-3 py-2 text-gray-200">{row.bar_size}</td>
                            <td className="px-3 py-2 font-mono text-gray-300">{row.lot_number || '—'}</td>
                            <td className="px-3 py-2 text-gray-300">{row.vendor}</td>
                            <td className="px-3 py-2 text-right text-gray-200">{row.received_bars}</td>
                            <td className="px-3 py-2 text-gray-400 whitespace-nowrap">
                              {row.received_at ? new Date(row.received_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <select
                                value={row.rack || ''}
                                onChange={e => handleAssignRack(row.id, e.target.value)}
                                className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-xs focus:outline-none focus:border-skynet-accent"
                              >
                                <option value="">Staging</option>
                                <option value="R1">R1</option>
                                <option value="R2">R2</option>
                                <option value="R3">R3</option>
                                <option value="R4">R4</option>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )
            })()}

            <h3 className="text-sm font-semibold text-gray-300 pt-1">Discrepancy Flags</h3>

            {/* Filter pills */}
            <div className="flex items-center gap-2">
              {['open', 'resolved', 'ignored', 'all'].map(f => {
                const labelMap = { open: 'Open', resolved: 'Resolved', ignored: 'Ignored', all: 'All' }
                const isActive = reconFilter === f
                return (
                  <button
                    key={f}
                    onClick={() => setReconFilter(f)}
                    className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                      isActive
                        ? 'border-skynet-accent text-skynet-accent bg-skynet-accent/10'
                        : 'border-gray-700 text-gray-400 hover:text-white'
                    }`}
                  >
                    {labelMap[f]}
                  </button>
                )
              })}
            </div>

            {(() => {
              const filteredFlags = reconFlags.filter(f => reconFilter === 'all' ? true : f.status === reconFilter)
              if (filteredFlags.length === 0) {
                return (
                  <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
                    <AlertTriangle size={48} className="mx-auto text-gray-600 mb-3" />
                    <p className="text-gray-400">No {reconFilter === 'all' ? '' : reconFilter} reconciliation flags.</p>
                  </div>
                )
              }
              return (
                <div className="overflow-x-auto rounded-lg border border-gray-700">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-800 text-gray-400 uppercase text-xs">
                      <tr>
                        <th className="px-4 py-3 text-left">Raised</th>
                        <th className="px-4 py-3 text-left">Type</th>
                        <th className="px-4 py-3 text-left">Lot #</th>
                        <th className="px-4 py-3 text-left">Material</th>
                        <th className="px-4 py-3 text-left">Bar Size</th>
                        <th className="px-4 py-3 text-right">Qty Δ</th>
                        <th className="px-4 py-3 text-right">Occurrences</th>
                        <th className="px-4 py-3 text-left">Job</th>
                        <th className="px-4 py-3 text-left">Status</th>
                        <th className="px-4 py-3 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-700">
                      {filteredFlags.map(flag => (
                        <tr key={flag.id} className="bg-gray-900 hover:bg-gray-800 transition-colors">
                          <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                            {new Date(flag.raised_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </td>
                          <td className="px-4 py-3">
                            {flag.flag_type === 'negative_inventory' ? (
                              <span className="text-xs px-2 py-0.5 bg-red-900/50 text-red-300 rounded whitespace-nowrap">Negative Inventory</span>
                            ) : (
                              <span className="text-xs px-2 py-0.5 bg-amber-900/50 text-amber-300 rounded whitespace-nowrap">Unknown Lot</span>
                            )}
                          </td>
                          <td className="px-4 py-3 font-mono text-skynet-accent text-xs">{flag.lot_number || '—'}</td>
                          <td className="px-4 py-3 text-gray-300">{flag.material_type || '—'}</td>
                          <td className="px-4 py-3 text-gray-300">{flag.bar_size || '—'}</td>
                          <td className="px-4 py-3 text-right font-mono text-gray-300">{flag.quantity_delta != null ? flag.quantity_delta : '—'}</td>
                          <td className="px-4 py-3 text-right text-gray-300">{flag.occurrence_count ?? 1}</td>
                          <td className="px-4 py-3 font-mono text-skynet-accent text-xs">{flag.jobs?.job_number || '—'}</td>
                          <td className="px-4 py-3">
                            <span className={`text-xs px-2 py-0.5 rounded ${
                              flag.status === 'open' ? 'bg-blue-900/50 text-blue-300'
                                : flag.status === 'resolved' ? 'bg-green-900/50 text-green-300'
                                : 'bg-gray-700 text-gray-400'
                            }`}>
                              {flag.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-center">
                            {flag.status === 'open' ? (
                              <button
                                onClick={() => openResolve(flag)}
                                className="text-xs px-3 py-1 bg-skynet-accent hover:bg-skynet-accent/80 text-white rounded transition-colors"
                              >
                                Resolve
                              </button>
                            ) : (
                              <div className="text-xs text-gray-500" title={flag.resolution_notes || ''}>
                                {flag.resolver?.full_name || '—'}
                                {flag._linked_po && (
                                  <span className="ml-1 px-1.5 py-0.5 bg-gray-700 text-gray-300 rounded whitespace-nowrap">PO {flag._linked_po}</span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })()}
          </div>
        )}

        {/* Receiving Tab */}
        {activeTab === 'receiving' && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">Raw Material Receiving Log</h2>
              <button
                onClick={() => { setReceivingForm({ material_id: '', vendor: '', po_number: '', lot_number: '', quantity: '', bar_length_inches: '', weight_lbs: '', price_per_lb: '', price_per_bar: '', rack: '', notes: '' }); setReceivingError(''); setReceivingTypeId(''); setReceivingSize(''); setReceivingCertFiles([]); setSavedReceiptId(null); setShowReceivingModal(true) }}
                className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-skynet-accent/80 text-white font-medium rounded-lg transition-colors"
              >
                <Plus size={18} /> Log Receipt
              </button>
            </div>

            {receivingLog.length === 0 ? (
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
                <PackageCheck size={48} className="mx-auto text-gray-600 mb-3" />
                <p className="text-gray-400">No receipts logged yet.</p>
                <p className="text-gray-600 text-sm mt-1">Click '+ Log Receipt' to record incoming raw material.</p>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-700">
                <table className="w-full text-sm">
                  <thead className="bg-gray-800 text-gray-400 uppercase text-xs">
                    <tr>
                      <th className="px-4 py-3 text-left">Received</th>
                      <th className="px-4 py-3 text-left">Material Type</th>
                      <th className="px-4 py-3 text-left">Bar Size</th>
                      <th className="px-4 py-3 text-left">Lot #</th>
                      <th className="px-4 py-3 text-left">PO</th>
                      <th className="px-4 py-3 text-right">Qty</th>
                      <th className="px-4 py-3 text-right">$/bar</th>
                      <th className="px-4 py-3 text-right">Bar Length</th>
                      <th className="px-4 py-3 text-left">Rack</th>
                      <th className="px-4 py-3 text-left">Vendor</th>
                      <th className="px-4 py-3 text-left">Received By</th>
                      <th className="px-4 py-3 text-left">Notes</th>
                      <th className="px-4 py-3 text-center">Cert</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-700">
                    {receivingLog.map(r => (
                      <tr key={r.id} className="bg-gray-900 hover:bg-gray-800 transition-colors">
                        <td className="px-4 py-3 text-gray-300 whitespace-nowrap">
                          {new Date(r.received_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                        </td>
                        <td className="px-4 py-3 text-white font-medium">{r.material_type}</td>
                        <td className="px-4 py-3 text-gray-300">{r.bar_size || '—'}</td>
                        <td className="px-4 py-3 font-mono text-skynet-accent text-xs">{r.lot_number}</td>
                        <td className="px-4 py-3 text-gray-300 text-xs">{r.po_number || '—'}</td>
                        <td className="px-4 py-3 text-white font-semibold text-right">{r.quantity}</td>
                        <td className="px-4 py-3 text-gray-300 text-right font-mono">
                          {r.price_per_bar != null ? `$${Number(r.price_per_bar).toFixed(2)}` : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-300 text-right font-mono">
                          {r.bar_length_inches ? `${r.bar_length_inches}"` : '—'}
                        </td>
                        <td className="px-4 py-3">
                          {r.rack ? (
                            <span className="text-xs px-2 py-0.5 bg-gray-700 text-gray-300 rounded">{r.rack}</span>
                          ) : (
                            <span className="text-xs px-2 py-0.5 bg-amber-900/50 text-amber-300 rounded">Staging</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-300">{r.vendor || '—'}</td>
                        <td className="px-4 py-3 text-gray-300">{r.received_by_profile?.full_name || '—'}</td>
                        <td className="px-4 py-3 text-gray-400 max-w-xs truncate">{r.notes || '—'}</td>
                        <td className="px-4 py-3 text-center">
                          {materialDocCounts[r.id] > 0 ? (
                            <button
                              onClick={() => openLotDocs(r)}
                              className="inline-flex items-center gap-1 text-skynet-accent hover:text-skynet-accent/80"
                              title="View material certs"
                            >
                              <Paperclip size={14} />
                              <span className="text-xs">{materialDocCounts[r.id]}</span>
                            </button>
                          ) : (
                            <span className="text-gray-600 text-xs">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Customers Tab */}
        {activeTab === 'customers' && <CustomersTab profile={profile} />}

        {/* Users Tab */}
        {activeTab === 'users' && <UsersTab profile={profile} />}
      </div>

      {/* Part Modal */}
      {showPartModal && (
        <div className={`fixed inset-0 bg-black/70 flex items-center justify-center p-4 ${showBOMModal ? 'z-[60]' : 'z-50'}`}>
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
              <h2 className="text-lg font-semibold text-white">
                {editingPart ? 'Edit Part' : `New ${
                  partForm.part_type === 'assembly' ? 'Product (Assembly)' :
                  partForm.part_type === 'finished_good' ? 'Product (Finished Good)' : 'Part'
                }`}
              </h2>
              <button onClick={() => setShowPartModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-gray-400 text-sm mb-1">Part Number *</label>
                <input
                  type="text"
                  value={partForm.part_number}
                  onChange={(e) => setPartForm({ ...partForm, part_number: e.target.value })}
                  placeholder="e.g., SK40S-2S"
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                />
              </div>

              <div>
                <label className="block text-gray-400 text-sm mb-1">Description</label>
                <input
                  type="text"
                  value={partForm.description}
                  onChange={(e) => setPartForm({ ...partForm, description: e.target.value })}
                  placeholder="Part description"
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Part Type</label>
                  <select
                    value={partForm.part_type}
                    onChange={(e) => {
                      const newType = e.target.value
                      setPartForm({ ...partForm, part_type: newType })
                      // SKY16: In create mode, keep docRequirements in sync with part_type.
                      // Manufactured → 3 defaults; anything else → empty. Edit mode never
                      // auto-resets so we don't blow away user data.
                      if (!editingPart) {
                        const defaults = computeDefaultDocRequirements(newType)
                        setDocRequirements(defaults)
                        setShowDocRequirements(defaults.length > 0)
                      }
                    }}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                  >
                    {editingPart ? (
                      <>
                        <option value="assembly">Product (Assembly)</option>
                        <option value="finished_good">Product (Finished Good)</option>
                        <option value="manufactured">Part (Manufactured)</option>
                        <option value="purchased">Part (Purchased)</option>
                      </>
                    ) : activeTab === 'assemblies' ? (
                      <>
                        <option value="assembly">Product (Assembly)</option>
                        <option value="finished_good">Product (Finished Good)</option>
                      </>
                    ) : (
                      <>
                        <option value="manufactured">Part (Manufactured)</option>
                        <option value="purchased">Part (Purchased)</option>
                      </>
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Unit Cost</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={partForm.unit_cost}
                    onChange={(e) => setPartForm({ ...partForm, unit_cost: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Customer</label>
                  <input
                    type="text"
                    value={partForm.customer}
                    onChange={(e) => setPartForm({ ...partForm, customer: e.target.value })}
                    placeholder="Customer name"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Specification</label>
                  <input
                    type="text"
                    value={partForm.specification}
                    onChange={(e) => setPartForm({ ...partForm, specification: e.target.value })}
                    placeholder="e.g., AS9100"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                  />
                </div>
              </div>

              {/* Material Type & Drawing Revision — for manufactured/FG */}
              {partForm.part_type !== 'assembly' && partForm.part_type !== 'purchased' && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-400 text-sm mb-1">Material Type</label>
                    <select
                      value={partForm.material_type_id || ''}
                      onChange={(e) => setPartForm({ ...partForm, material_type_id: e.target.value || null })}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                    >
                      <option value="">-- None --</option>
                      {materialTypes.map(mt => (
                        <option key={mt.id} value={mt.id}>{mt.name}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-gray-400 text-sm mb-1">Drawing Revision</label>
                    <input
                      type="text"
                      value={partForm.drawing_revision}
                      onChange={(e) => setPartForm({ ...partForm, drawing_revision: e.target.value })}
                      placeholder="e.g., Rev C"
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                    />
                  </div>
                </div>
              )}

              {partForm.part_type !== 'assembly' && partForm.part_type !== 'purchased' && (
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={partForm.requires_passivation}
                    onChange={(e) => setPartForm({ ...partForm, requires_passivation: e.target.checked })}
                    className="w-5 h-5 rounded bg-gray-800 border-gray-600 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-gray-900"
                  />
                  <div className="flex items-center gap-2">
                    <Beaker size={16} className="text-cyan-400" />
                    <span className="text-white">Requires Finishing</span>
                  </div>
                </label>
              )}

              {editingPart && (
                <div className={`flex items-center gap-3 p-3 rounded-lg border ${
                  partForm.is_active
                    ? 'bg-emerald-900/20 border-emerald-800/50'
                    : 'bg-amber-900/20 border-amber-800/50'
                }`}>
                  <label className="flex items-center gap-2 cursor-pointer flex-1">
                    <input
                      type="checkbox"
                      checked={partForm.is_active}
                      onChange={(e) => setPartForm({ ...partForm, is_active: e.target.checked })}
                      className="w-4 h-4 rounded"
                    />
                    <div>
                      <div className="text-white text-sm font-medium">
                        {partForm.is_active ? 'Active' : 'Inactive — Pending Master Data'}
                      </div>
                      <div className="text-gray-400 text-xs">
                        {partForm.is_active
                          ? 'Visible to schedulers, customer service, and operators.'
                          : 'Hidden from schedule/WO creation. Visible to schedulers as a "needs activation" flag.'}
                      </div>
                    </div>
                  </label>
                </div>
              )}

              {/* Routing Steps — for manufactured/assembly/finished_good */}
              {partForm.part_type !== 'purchased' && (
                <div className="border border-gray-700 rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-gray-400 text-sm font-medium">
                      Routing Steps *
                      <span className="text-gray-600 font-normal ml-1">({routingSteps.length})</span>
                    </p>
                    <div className="flex items-center gap-2">
                      {routingTemplates.length > 0 && (
                        <select
                          onChange={(e) => { loadRoutingFromTemplate(e.target.value); e.target.value = '' }}
                          defaultValue=""
                          className="px-2 py-1 bg-gray-800 border border-gray-700 rounded text-xs text-gray-300 focus:outline-none focus:border-skynet-accent"
                        >
                          <option value="" disabled>Load from Template...</option>
                          {routingTemplates
                            .filter(t => {
                              const isAssemblyPart =
                                partForm.part_type === 'assembly' || partForm.part_type === 'finished_good'
                              return isAssemblyPart
                                ? t.template_type === 'assembly'
                                : t.template_type === 'component'
                            })
                            .map(t => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                        </select>
                      )}
                      <button
                        type="button"
                        onClick={addRoutingStep}
                        className="flex items-center gap-1 text-xs text-skynet-accent hover:text-blue-400 transition-colors"
                      >
                        <Plus size={14} />
                        Add Step
                      </button>
                    </div>
                  </div>

                  {routingSteps.length === 0 ? (
                    <p className="text-gray-600 text-sm text-center py-4">
                      No routing steps &mdash; load from a template or add manually
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {routingSteps.map((step, idx) => (
                        <div
                          key={idx}
                          draggable
                          onDragStart={() => setDraggedStepIdx(idx)}
                          onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx) }}
                          onDrop={(e) => {
                            e.preventDefault()
                            if (draggedStepIdx !== null) reorderRoutingSteps(draggedStepIdx, idx)
                            setDraggedStepIdx(null)
                            setDragOverIdx(null)
                          }}
                          onDragEnd={() => { setDraggedStepIdx(null); setDragOverIdx(null) }}
                          className={`bg-gray-800 rounded-lg p-3 border border-gray-700 ${dragOverIdx === idx ? 'border-t-2 border-t-skynet-accent' : ''} ${draggedStepIdx === idx ? 'opacity-50' : ''}`}
                        >
                          <div className="flex items-center gap-2">
                            <GripVertical size={14} className="text-gray-600 hover:text-gray-400 cursor-grab active:cursor-grabbing flex-shrink-0" />
                            <span className="text-gray-500 text-xs font-mono w-5 text-center">{idx + 1}</span>
                            <input
                              type="text"
                              value={step.step_name}
                              onChange={(e) => updateRoutingStep(idx, 'step_name', e.target.value)}
                              placeholder="Step name *"
                              className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                            />
                            <select
                              value={step.step_type}
                              onChange={(e) => updateRoutingStep(idx, 'step_type', e.target.value)}
                              className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                            >
                              <option value="internal">Internal</option>
                              <option value="external">External</option>
                            </select>
                            <input
                              type="text"
                              value={step.default_station}
                              onChange={(e) => updateRoutingStep(idx, 'default_station', e.target.value)}
                              placeholder="Station"
                              className="w-28 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                            />
                            <div className="flex items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => moveRoutingStep(idx, -1)}
                                disabled={idx === 0}
                                className="p-1 text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                                title="Move up"
                              >
                                <ChevronUp size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveRoutingStep(idx, 1)}
                                disabled={idx === routingSteps.length - 1}
                                className="p-1 text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                                title="Move down"
                              >
                                <ChevronDown size={14} />
                              </button>
                              <button
                                type="button"
                                onClick={() => removeRoutingStep(idx)}
                                className="p-1 text-red-400 hover:text-red-300"
                                title="Remove step"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Document Requirements — collapsible section */}
              {partForm.part_type !== 'assembly' && (
                <div className="border border-gray-700 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setShowDocRequirements(!showDocRequirements)}
                    className="w-full px-4 py-3 flex items-center justify-between bg-gray-800/50 hover:bg-gray-800 transition-colors"
                  >
                    <p className="text-gray-400 text-sm font-medium">
                      Document Requirements
                      {docRequirements.length > 0 && (
                        <span className="text-gray-600 font-normal ml-1">({docRequirements.length})</span>
                      )}
                    </p>
                    <ChevronDown
                      size={16}
                      className={`text-gray-500 transition-transform ${showDocRequirements ? 'rotate-180' : ''}`}
                    />
                  </button>

                  {showDocRequirements && (
                    <div className="p-4 space-y-3 border-t border-gray-700">
                      {docRequirements.length === 0 ? (
                        <p className="text-gray-600 text-sm text-center py-2">No document requirements configured</p>
                      ) : (
                        <div className="space-y-2">
                          {docRequirements.map((req, idx) => (
                            <div key={idx} className="flex items-center gap-2 bg-gray-800 rounded p-2">
                              <select
                                value={req.document_type_id || ''}
                                onChange={(e) => {
                                  const updated = [...docRequirements]
                                  updated[idx] = { ...updated[idx], document_type_id: e.target.value || null }
                                  setDocRequirements(updated)
                                }}
                                className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                              >
                                <option value="">-- Doc Type --</option>
                                {documentTypes.map(dt => (
                                  <option key={dt.id} value={dt.id}>{dt.name}</option>
                                ))}
                              </select>
                              <select
                                value={req.required_at}
                                onChange={(e) => {
                                  const updated = [...docRequirements]
                                  updated[idx] = { ...updated[idx], required_at: e.target.value }
                                  setDocRequirements(updated)
                                }}
                                className="w-40 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                              >
                                <option value="compliance_review">Compliance Review</option>
                                <option value="manufacturing_complete">After Manufacturing</option>
                                <option value="tco">Before TCO</option>
                              </select>
                              <label className="flex items-center gap-1 text-xs text-gray-400 whitespace-nowrap cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={req.is_required}
                                  onChange={(e) => {
                                    const updated = [...docRequirements]
                                    updated[idx] = { ...updated[idx], is_required: e.target.checked }
                                    setDocRequirements(updated)
                                  }}
                                  className="w-4 h-4 rounded bg-gray-700 border-gray-600 text-skynet-accent focus:ring-skynet-accent focus:ring-offset-gray-900"
                                />
                                Req
                              </label>
                              <input
                                type="text"
                                value={req.notes}
                                onChange={(e) => {
                                  const updated = [...docRequirements]
                                  updated[idx] = { ...updated[idx], notes: e.target.value }
                                  setDocRequirements(updated)
                                }}
                                placeholder="Notes"
                                className="w-24 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                              />
                              <button
                                type="button"
                                onClick={() => setDocRequirements(docRequirements.filter((_, i) => i !== idx))}
                                className="p-1 text-red-400 hover:text-red-300"
                                title="Remove"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => setDocRequirements([...docRequirements, {
                          document_type_id: null,
                          required_at: 'compliance_review',
                          is_required: true,
                          notes: ''
                        }])}
                        className="flex items-center gap-1 text-xs text-skynet-accent hover:text-blue-400 transition-colors"
                      >
                        <Plus size={14} />
                        Add Requirement
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Machine Preferences - for manufactured, finished_good */}
              {partForm.part_type !== 'assembly' && partForm.part_type !== 'purchased' && machines.length > 0 && (
                <div className="border border-gray-700 rounded-lg p-4 space-y-3">
                  <p className="text-gray-400 text-sm font-medium">Machine Preferences</p>
                  
                  {/* Primary Machine */}
                  <div>
                    <label className="block text-gray-500 text-xs mb-1">Primary Machine</label>
                    <select
                      value={preferredMachineId || ''}
                      onChange={(e) => {
                        const newId = e.target.value || null
                        setPreferredMachineId(newId)
                        // Remove from secondaries if it was there
                        if (newId) {
                          setSecondaryMachineIds(prev => prev.filter(id => id !== newId))
                        }
                      }}
                      className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                    >
                      <option value="">— None —</option>
                      {machines.map(m => (
                        <option key={m.id} value={m.id}>{m.name} ({m.locations?.name || ""})</option>
                      ))}
                    </select>
                  </div>

                  {/* Secondary Machines */}
                  {secondaryMachineIds.map((secId, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <div className="flex-1">
                        <label className="block text-gray-500 text-xs mb-1">
                          Secondary Machine {secondaryMachineIds.length > 1 ? `#${idx + 1}` : ''}
                        </label>
                        <select
                          value={secId || ''}
                          onChange={(e) => {
                            const updated = [...secondaryMachineIds]
                            updated[idx] = e.target.value || null
                            setSecondaryMachineIds(updated)
                          }}
                          className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                        >
                          <option value="">— None —</option>
                          {machines
                            .filter(m => m.id !== preferredMachineId && !secondaryMachineIds.some((sid, sidx) => sid === m.id && sidx !== idx))
                            .map(m => (
                              <option key={m.id} value={m.id}>{m.name} ({m.locations?.name || ""})</option>
                            ))}
                        </select>
                      </div>
                      <button
                        onClick={() => setSecondaryMachineIds(prev => prev.filter((_, i) => i !== idx))}
                        className="mt-5 p-2 text-gray-500 hover:text-red-400 transition-colors"
                        title="Remove"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  ))}

                  {/* Add Secondary button */}
                  {secondaryMachineIds.length < 5 && (
                    <button
                      onClick={() => setSecondaryMachineIds(prev => [...prev, null])}
                      className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
                    >
                      <Plus size={14} />
                      Add Secondary Machine
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3 flex-shrink-0">
              <button
                onClick={() => setShowPartModal(false)}
                className="flex-1 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSavePart}
                disabled={saving}
                className="flex-1 py-2 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {saving ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Check size={18} />
                )}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BOM Modal */}
      {showBOMModal && selectedAssembly && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Layers className="text-purple-400" size={20} />
                  Bill of Materials
                  {selectedAssembly.is_active ? (
                    <span className="text-xs font-normal px-2 py-0.5 bg-emerald-900/50 text-emerald-300 rounded border border-emerald-700/50">Active</span>
                  ) : (
                    <span className="text-xs font-normal px-2 py-0.5 bg-amber-900/50 text-amber-300 rounded border border-amber-700/50">Inactive — Pending Master Data</span>
                  )}
                </h2>
                <p className="text-gray-500 text-sm">{selectedAssembly.part_number} - {selectedAssembly.description}</p>
              </div>
              <button onClick={() => setShowBOMModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Current BOM */}
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide">
                    Current Parts ({bomComponents.length})
                  </h3>
                  {bomComponents.length > 0 && (() => {
                    const total = bomComponents.length
                    const activeCount = bomComponents.filter(b => b.component?.is_active !== false).length
                    const allActive = activeCount === total
                    return (
                      <span className={`text-xs px-2 py-0.5 rounded border ${
                        allActive
                          ? 'bg-emerald-900/30 text-emerald-300 border-emerald-800/50'
                          : 'bg-amber-900/30 text-amber-300 border-amber-800/50'
                      }`}>
                        {activeCount} of {total} component{total === 1 ? '' : 's'} active
                      </span>
                    )
                  })()}
                </div>
                {bomComponents.length === 0 ? (
                  <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-6 text-center">
                    <p className="text-gray-500">No parts added yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {[...bomComponents]
                      .sort((a, b) => {
                        // Inactive first; then by sort_order
                        const aActive = a.component?.is_active !== false ? 1 : 0
                        const bActive = b.component?.is_active !== false ? 1 : 0
                        if (aActive !== bActive) return aActive - bActive
                        return (a.sort_order || 0) - (b.sort_order || 0)
                      })
                      .map(bom => {
                        const isInactive = bom.component?.is_active === false
                        return (
                          <div
                            key={bom.id}
                            className={`border rounded-lg p-3 flex items-center justify-between ${
                              isInactive
                                ? 'bg-gray-900/40 border-amber-900/40'
                                : 'bg-gray-800 border-gray-700'
                            }`}
                          >
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <Wrench size={16} className="text-gray-500 flex-shrink-0" />
                              <div className="min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-skynet-accent font-mono">{bom.component?.part_number}</span>
                                  <span className="text-gray-500">{bom.component?.description}</span>
                                  {isInactive && (
                                    <span className="text-xs px-2 py-0.5 bg-amber-900/50 text-amber-300 rounded border border-amber-700/50">Inactive — Pending Master Data</span>
                                  )}
                                  {bom.component?.requires_passivation && (
                                    <span className="text-xs text-cyan-400">
                                      <Beaker size={10} className="inline" /> Finishing
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                            <div className="flex items-center gap-3 flex-shrink-0">
                              <div className="flex items-center gap-2">
                                <span className="text-gray-500 text-sm">Qty:</span>
                                <input
                                  type="number"
                                  min="1"
                                  value={bom.quantity}
                                  onChange={(e) => updateBOMQuantity(bom.id, e.target.value)}
                                  className="w-16 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-center text-sm"
                                />
                              </div>
                              <button
                                onClick={() => {
                                  // Find the full part record from `parts` so the edit modal has all fields
                                  const fullPart = parts.find(p => p.id === bom.component?.id)
                                  if (fullPart) openPartModal(fullPart)
                                }}
                                title={isInactive ? 'Edit & activate this component' : 'Edit this component'}
                                className="p-1.5 text-skynet-accent hover:text-blue-300 hover:bg-blue-900/20 rounded"
                              >
                                <Edit2 size={16} />
                              </button>
                              <button
                                onClick={() => removeFromBOM(bom.id)}
                                className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded"
                              >
                                <Trash2 size={16} />
                              </button>
                            </div>
                          </div>
                        )
                      })}
                  </div>
                )}
              </div>

              {/* Add Parts */}
              <div>
                <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
                  Add Parts
                </h3>
                <div className="space-y-1 max-h-60 overflow-y-auto">
                  {availableComponents
                    .filter(c => !bomComponents.some(b => b.component?.id === c.id))
                    .map(comp => (
                      <button
                        key={comp.id}
                        onClick={() => addToBOM(comp.id)}
                        disabled={saving}
                        className="w-full flex items-center justify-between px-3 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-left transition-colors disabled:opacity-50"
                      >
                        <div className="flex items-center gap-2">
                          <Plus size={14} className="text-green-400" />
                          <span className="text-skynet-accent font-mono text-sm">{comp.part_number}</span>
                          <span className="text-gray-500 text-sm">{comp.description}</span>
                          {comp.requires_passivation && (
                            <Beaker size={12} className="text-cyan-400" />
                          )}
                        </div>
                        <ChevronRight size={14} className="text-gray-500" />
                      </button>
                    ))}
                  {availableComponents.filter(c => !bomComponents.some(b => b.component?.id === c.id)).length === 0 && (
                    <p className="text-gray-500 text-sm text-center py-4">
                      All available parts have been added
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-800">
              <button
                onClick={() => setShowBOMModal(false)}
                className="w-full py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Material Modal */}
      {showMaterialModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                {editingMaterial ? 'Edit Material Type' : 'New Material Type'}
              </h2>
              <button onClick={() => setShowMaterialModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-gray-400 text-sm mb-1">Material Name *</label>
                <input
                  type="text"
                  value={materialForm.name}
                  onChange={(e) => setMaterialForm({ ...materialForm, name: e.target.value })}
                  placeholder="e.g., 301 Stainless Steel"
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Short Code</label>
                  <input
                    type="text"
                    value={materialForm.short_code}
                    onChange={(e) => setMaterialForm({ ...materialForm, short_code: e.target.value })}
                    placeholder="e.g., 301SS"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Category</label>
                  <input
                    type="text"
                    value={materialForm.category}
                    onChange={(e) => setMaterialForm({ ...materialForm, category: e.target.value })}
                    placeholder="e.g., Steel"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                  />
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button
                onClick={() => setShowMaterialModal(false)}
                className="flex-1 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveMaterial}
                disabled={saving}
                className="flex-1 py-2 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {saving ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Check size={18} />
                )}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bar Size Modal */}
      {showBarSizeModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                {editingBarSize ? 'Edit Bar Size' : 'New Bar Size'}
              </h2>
              <button onClick={() => setShowBarSizeModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <div>
                <label className="block text-gray-400 text-sm mb-1">Size Display *</label>
                <input
                  type="text"
                  value={barSizeForm.size}
                  onChange={(e) => setBarSizeForm({ ...barSizeForm, size: e.target.value })}
                  placeholder='e.g., 1/4" or 0.250 dia'
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Decimal (inches)</label>
                  <input
                    type="number"
                    step="0.001"
                    value={barSizeForm.size_decimal}
                    onChange={(e) => setBarSizeForm({ ...barSizeForm, size_decimal: e.target.value })}
                    placeholder="e.g., 0.250"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Shape</label>
                  <select
                    value={barSizeForm.shape}
                    onChange={(e) => setBarSizeForm({ ...barSizeForm, shape: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                  >
                    <option value="round">Round</option>
                    <option value="hex">Hex</option>
                    <option value="square">Square</option>
                    <option value="flat">Flat</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
              <button
                onClick={() => setShowBarSizeModal(false)}
                className="flex-1 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveBarSize}
                disabled={saving}
                className="flex-1 py-2 bg-skynet-accent hover:bg-blue-600 disabled:bg-gray-700 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {saving ? (
                  <Loader2 size={18} className="animate-spin" />
                ) : (
                  <Check size={18} />
                )}
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BOM Upload Modal */}
      {showBOMUpload && (
        <BOMUpload
          onComplete={() => {
            setShowBOMUpload(false)
            fetchData()
          }}
          onCancel={() => setShowBOMUpload(false)}
        />
      )}

      {/* Material Definition Modal */}
      {showMaterialMasterModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">
                {editingMaterialMaster ? 'Edit Material' : 'Add Material'}
              </h2>
              <button onClick={() => setShowMaterialMasterModal(false)} className="text-gray-400 hover:text-white">
                <X size={20} />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Material Type *</label>
                <select
                  value={materialMasterForm.material_type_id}
                  onChange={e => setMaterialMasterForm(f => ({ ...f, material_type_id: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                >
                  <option value="">— Select —</option>
                  {materialTypes.map(mt => (
                    <option key={mt.id} value={mt.id}>{mt.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Bar Size (inches) *</label>
                <input
                  type="number" step="0.001"
                  value={materialMasterForm.bar_size_inches}
                  onChange={e => setMaterialMasterForm(f => ({ ...f, bar_size_inches: e.target.value }))}
                  placeholder="e.g. 0.375"
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Density (lb/in³)</label>
                <input
                  type="number" step="0.0001"
                  value={materialMasterForm.density_lbs_per_cubic_inch}
                  onChange={e => setMaterialMasterForm(f => ({ ...f, density_lbs_per_cubic_inch: e.target.value }))}
                  placeholder="e.g. 0.289"
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Vendor</label>
                <input
                  type="text"
                  value={materialMasterForm.vendor}
                  onChange={e => setMaterialMasterForm(f => ({ ...f, vendor: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
              </div>
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Notes</label>
                <textarea
                  value={materialMasterForm.notes}
                  onChange={e => setMaterialMasterForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent resize-none"
                />
              </div>
            </div>

            {existingInactive ? (
              <div className="border border-amber-700/50 bg-amber-900/20 rounded-lg p-3 text-sm text-amber-200 space-y-2">
                <div>An inactive entry for this combination exists. Reactivate it instead of creating a duplicate?</div>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setExistingInactive(null)}
                    className="px-3 py-1.5 text-gray-300 hover:text-white text-xs"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleReactivateExisting}
                    disabled={saving}
                    className="px-3 py-1.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-xs font-medium rounded flex items-center gap-1"
                  >
                    {saving && <Loader2 size={12} className="animate-spin" />}
                    Reactivate Existing
                  </button>
                </div>
              </div>
            ) : materialModalError ? (
              <div className="border border-red-700/50 bg-red-900/20 rounded-lg p-3 text-sm text-red-200">
                {materialModalError}
              </div>
            ) : null}

            <div className="flex justify-end gap-3 pt-2">
              <button onClick={() => setShowMaterialMasterModal(false)} className="px-4 py-2 text-gray-400 hover:text-white">
                Cancel
              </button>
              <button
                onClick={handleSaveMaterialMaster}
                disabled={saving || !materialMasterForm.material_type_id || !materialMasterForm.bar_size_inches || !!existingInactive}
                className="px-6 py-2 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
                {editingMaterialMaster ? 'Save Changes' : 'Add Material'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Material Confirmation Modal */}
      {materialToDelete && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="text-red-400 flex-shrink-0 mt-0.5" size={20} />
              <div className="space-y-2">
                <h3 className="text-lg font-bold text-white">Permanently delete this material?</h3>
                <div className="text-sm text-gray-300 space-y-0.5">
                  <div><span className="text-gray-500">Type:</span> {materialToDelete.material_type?.name || '—'}</div>
                  <div><span className="text-gray-500">Bar Size:</span> {materialToDelete.bar_size_inches}"</div>
                  <div><span className="text-gray-500">Vendor:</span> {materialToDelete.vendor || '—'}</div>
                </div>
                <p className="text-sm text-red-300">This cannot be undone.</p>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setMaterialToDelete(null)}
                className="px-4 py-2 text-gray-400 hover:text-white"
                disabled={deleting === materialToDelete.id}
              >
                Cancel
              </button>
              <button
                onClick={handleDeleteMaterialMaster}
                disabled={deleting === materialToDelete.id}
                className="px-6 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
              >
                {deleting === materialToDelete.id && <Loader2 size={16} className="animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Receiving Log Modal */}
      {showReceivingModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Log Material Receipt</h2>
              <button onClick={closeReceivingModal} className="text-gray-400 hover:text-white">
                <X size={20} />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* Vendor */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Vendor *</label>
                {materialVendors.length > 0 ? (
                  <select
                    value={receivingForm.vendor}
                    onChange={e => {
                      setReceivingForm(f => ({ ...f, vendor: e.target.value, material_id: '' }))
                      setReceivingTypeId('')
                      setReceivingSize('')
                    }}
                    className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                  >
                    <option value="">— Select vendor —</option>
                    {materialVendors.map(v => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                ) : (
                  <p className="mt-1 text-sm text-yellow-500">
                    No vendors defined yet. Add material definitions with vendors first.
                  </p>
                )}
              </div>

              {/* Material Type */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Material Type *</label>
                <select
                  value={receivingTypeId}
                  onChange={e => {
                    setReceivingTypeId(e.target.value)
                    setReceivingSize('')
                    setReceivingForm(f => ({ ...f, material_id: '' }))
                  }}
                  disabled={!receivingForm.vendor || receivingTypes.length === 0}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent disabled:opacity-50"
                >
                  <option value="">— Select type —</option>
                  {receivingTypes.map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>

              {/* Bar Size */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Bar Size *</label>
                <select
                  value={receivingSize}
                  onChange={e => {
                    const size = e.target.value
                    setReceivingSize(size)
                    const resolved = materials.find(m =>
                      m.vendor === receivingForm.vendor &&
                      String(m.material_type?.id) === String(receivingTypeId) &&
                      Number(m.bar_size_inches) === Number(size) &&
                      m.is_active
                    )
                    setReceivingForm(f => ({ ...f, material_id: resolved?.id || '' }))
                  }}
                  disabled={!receivingTypeId || receivingSizes.length === 0}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent disabled:opacity-50"
                >
                  <option value="">— Select size —</option>
                  {receivingSizes.map(s => (
                    <option key={s} value={s}>{s}"</option>
                  ))}
                </select>
              </div>

              {/* Lot # */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Lot # *</label>
                <input
                  type="text"
                  value={receivingForm.lot_number}
                  onChange={e => setReceivingForm(f => ({ ...f, lot_number: e.target.value }))}
                  placeholder="e.g. 2026-001"
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
              </div>

              {/* Quantity */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Quantity (bars) *</label>
                <input
                  type="number" min="1"
                  value={receivingForm.quantity}
                  onChange={e => setReceivingForm(f => ({ ...f, quantity: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
              </div>

              {/* Bar Length */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Bar Length (inches) *</label>
                <input
                  type="number" min="1" step="any"
                  value={receivingForm.bar_length_inches}
                  onChange={e => setReceivingForm(f => ({ ...f, bar_length_inches: e.target.value }))}
                  placeholder="e.g. 144"
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
              </div>

              {/* PO Number */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">PO Number *</label>
                <input
                  type="text"
                  value={receivingForm.po_number}
                  onChange={e => setReceivingForm(f => ({ ...f, po_number: e.target.value }))}
                  placeholder="e.g. PO-12345"
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
              </div>

              {/* Total Weight */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Total Weight (lbs)</label>
                <input
                  type="number" min="0" step="any"
                  value={receivingForm.weight_lbs}
                  onChange={e => setReceivingForm(f => ({ ...f, weight_lbs: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
              </div>

              {/* Price / lb */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Price / lb ($)</label>
                <input
                  type="number" min="0" step="0.01"
                  value={receivingForm.price_per_lb}
                  onChange={e => setReceivingForm(f => ({ ...f, price_per_lb: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
              </div>

              {/* Price / bar */}
              <div>
                <label className="text-xs text-gray-400 uppercase tracking-wide">Price / bar ($)</label>
                <input
                  type="number" min="0" step="0.01"
                  value={receivingForm.price_per_bar}
                  onChange={e => setReceivingForm(f => ({ ...f, price_per_bar: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                />
                {/* Suggest $/bar from weight × $/lb ÷ qty when price/bar is still blank */}
                {receivingForm.weight_lbs && receivingForm.price_per_lb && receivingForm.quantity && !receivingForm.price_per_bar && (() => {
                  const qty = parseFloat(receivingForm.quantity)
                  const suggested = qty > 0
                    ? (parseFloat(receivingForm.weight_lbs) * parseFloat(receivingForm.price_per_lb)) / qty
                    : null
                  if (suggested == null || !isFinite(suggested)) return null
                  return (
                    <div className="mt-1 flex items-center gap-2">
                      <span className="text-xs text-gray-500">≈ ${suggested.toFixed(2)}/bar</span>
                      <button
                        type="button"
                        onClick={() => setReceivingForm(f => ({ ...f, price_per_bar: suggested.toFixed(2) }))}
                        className="text-xs px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded"
                      >
                        Use
                      </button>
                    </div>
                  )
                })()}
              </div>

              {/* Rack (full width) */}
              <div className="sm:col-span-2">
                <label className="text-xs text-gray-400 uppercase tracking-wide">Rack</label>
                <select
                  value={receivingForm.rack}
                  onChange={e => setReceivingForm(f => ({ ...f, rack: e.target.value }))}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                >
                  <option value="">Staging (unassigned)</option>
                  <option value="R1">R1</option>
                  <option value="R2">R2</option>
                  <option value="R3">R3</option>
                  <option value="R4">R4</option>
                </select>
                <p className="text-xs text-gray-600 mt-1">Leave as Staging if rack location is not yet known.</p>
              </div>

              {/* Notes (full width) */}
              <div className="sm:col-span-2">
                <label className="text-xs text-gray-400 uppercase tracking-wide">Notes</label>
                <textarea
                  value={receivingForm.notes}
                  onChange={e => setReceivingForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent resize-none"
                />
              </div>

              {/* Material Cert upload (full width) */}
              <div className="sm:col-span-2">
                <label className="text-xs text-gray-400 uppercase tracking-wide">Material Cert</label>
                <input
                  type="file"
                  accept=".pdf,image/*"
                  multiple
                  onChange={e => {
                    const files = Array.from(e.target.files || [])
                    if (files.length) setReceivingCertFiles(prev => [...prev, ...files])
                    e.target.value = ''
                  }}
                  className="block w-full mt-1 text-sm text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-gray-700 file:text-gray-200 hover:file:bg-gray-600"
                />
                {receivingCertFiles.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {receivingCertFiles.map((f, i) => (
                      <li key={i} className="flex items-center justify-between text-xs bg-gray-800 rounded px-2 py-1">
                        <span className="text-gray-300 truncate">{f.name}</span>
                        <button
                          type="button"
                          onClick={() => setReceivingCertFiles(prev => prev.filter((_, idx) => idx !== i))}
                          className="text-gray-500 hover:text-red-400 flex-shrink-0 ml-2"
                          title="Remove"
                        >
                          <X size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {receivingError && (
              <div className="px-3 py-2 bg-red-900/40 border border-red-700 rounded-lg text-sm text-red-300">
                {receivingError}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              {savedReceiptId ? (
                <button onClick={closeReceivingModal} className="px-6 py-2 bg-skynet-accent hover:bg-skynet-accent/80 text-white font-medium rounded-lg transition-colors">
                  Close
                </button>
              ) : (
                <>
                  <button onClick={closeReceivingModal} className="px-4 py-2 text-gray-400 hover:text-white">
                    Cancel
                  </button>
                  <button
                    onClick={handleSaveReceiving}
                    disabled={saving || !receivingForm.vendor || !receivingForm.material_id || !receivingForm.lot_number || !receivingForm.quantity || !receivingForm.bar_length_inches}
                    className="px-6 py-2 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
                  >
                    {saving && <Loader2 size={16} className="animate-spin" />}
                    Log Receipt
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reconciliation Resolve Modal */}
      {resolvingFlag && (() => {
        const isUnknownLot = resolvingFlag.flag_type === 'unknown_lot'
        const hasReceipts = resolveReceipts.length > 0
        const linkMode = canLink && isUnknownLot && hasReceipts
        const totalBars = resolveOrphans.reduce((s, o) => s + (o.quantity_used || 0), 0)
        const selectedReceipt = resolveReceipts.find(r => r.id === resolveSelectedReceiptId)
        const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
        return (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Resolve Flag</h2>
              <button onClick={closeResolveModal} className="text-gray-400 hover:text-white">
                <X size={20} />
              </button>
            </div>
            <div className="text-sm text-gray-400">
              <span className="font-mono text-skynet-accent">{resolvingFlag.lot_number || '—'}</span>
              {' · '}{resolvingFlag.material_type || '—'}
              {' · '}{resolvingFlag.flag_type === 'negative_inventory' ? 'Negative Inventory' : 'Unknown Lot'}
            </div>

            {resolveLoading ? (
              <div className="py-6 text-center text-gray-500 text-sm">
                <Loader2 size={20} className="animate-spin inline" />
              </div>
            ) : (
              <>
                {linkMode && (
                  <>
                    {/* Orphaned staging events */}
                    <div>
                      <label className="text-xs text-gray-400 uppercase tracking-wide">
                        Staged (unlinked) — {totalBars} bars across {resolveOrphans.length} event{resolveOrphans.length !== 1 ? 's' : ''}
                      </label>
                      <ul className="mt-1 space-y-1 max-h-40 overflow-y-auto">
                        {resolveOrphans.map(o => (
                          <li key={o.id} className="flex items-center justify-between text-xs bg-gray-800 rounded px-2 py-1">
                            <span className="text-gray-400">{fmtDate(o.used_at)}</span>
                            <span className="text-gray-300">{o.quantity_used} bars</span>
                            <span className="font-mono text-skynet-accent">{o.jobs?.job_number || '—'}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {/* Matching receipt(s) */}
                    <div>
                      <label className="text-xs text-gray-400 uppercase tracking-wide">
                        Matching receipt{resolveReceipts.length > 1 ? 's' : ''}
                      </label>
                      {resolveReceipts.length === 1 ? (
                        <div className="mt-1 bg-gray-800 rounded-lg px-3 py-2 border border-skynet-accent/40">
                          <div className="text-sm text-gray-200">PO {resolveReceipts[0].po_number || '—'} · {resolveReceipts[0].vendor || '—'}</div>
                          <div className="text-xs text-gray-500">{resolveReceipts[0].quantity} bars · received {fmtDate(resolveReceipts[0].received_at)}</div>
                        </div>
                      ) : (
                        <div className="mt-1 space-y-1">
                          {resolveReceipts.map(r => (
                            <label
                              key={r.id}
                              className={`flex items-start gap-2 rounded-lg px-3 py-2 cursor-pointer border ${
                                resolveSelectedReceiptId === r.id ? 'bg-gray-800 border-skynet-accent/60' : 'bg-gray-800/50 border-gray-700 hover:border-gray-600'
                              }`}
                            >
                              <input
                                type="radio"
                                name="resolveReceipt"
                                checked={resolveSelectedReceiptId === r.id}
                                onChange={() => setResolveSelectedReceiptId(r.id)}
                                className="mt-1"
                              />
                              <div>
                                <div className="text-sm text-gray-200">PO {r.po_number || '—'} · {r.vendor || '—'}</div>
                                <div className="text-xs text-gray-500">{r.quantity} bars · received {fmtDate(r.received_at)}</div>
                              </div>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}

                {canLink && isUnknownLot && !hasReceipts && (
                  <div className="px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-400">
                    No receipt found for lot {resolvingFlag.lot_number}. Log it in the Receiving tab first to link staged material.
                  </div>
                )}

                <div>
                  <label className="text-xs text-gray-400 uppercase tracking-wide">
                    {linkMode ? 'Notes (optional)' : 'Resolution Notes *'}
                  </label>
                  <textarea
                    value={resolutionNotes}
                    onChange={e => setResolutionNotes(e.target.value)}
                    rows={3}
                    placeholder={linkMode ? 'Optional — the link adds an audit note automatically…' : 'Describe how this discrepancy was resolved…'}
                    className="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent resize-none"
                  />
                </div>

                {resolveError && (
                  <div className="px-3 py-2 bg-red-900/40 border border-red-700 rounded-lg text-sm text-red-300">
                    {resolveError}
                  </div>
                )}

                <div className="flex flex-wrap justify-end gap-3 pt-2">
                  <button
                    onClick={() => handleResolveFlag('ignored')}
                    disabled={resolvingSaving || !resolutionNotes.trim()}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 font-medium rounded-lg transition-colors flex items-center gap-2"
                    title="Ignored lots are never re-flagged by the DB trigger"
                  >
                    {resolvingSaving && <Loader2 size={16} className="animate-spin" />}
                    Ignore Lot
                  </button>
                  <button
                    onClick={() => handleResolveFlag('resolved')}
                    disabled={resolvingSaving || !resolutionNotes.trim()}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 font-medium rounded-lg transition-colors flex items-center gap-2"
                  >
                    {resolvingSaving && <Loader2 size={16} className="animate-spin" />}
                    {linkMode ? 'Mark Resolved (no link)' : 'Mark Resolved'}
                  </button>
                  {linkMode && (
                    <button
                      onClick={handleLinkAndResolve}
                      disabled={resolvingSaving || !resolveSelectedReceiptId}
                      className="px-6 py-2 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
                    >
                      {resolvingSaving && <Loader2 size={16} className="animate-spin" />}
                      Link {totalBars} bars to PO {selectedReceipt?.po_number || '—'} &amp; Resolve
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
        )
      })()}

      {/* Receiving-save link nudge */}
      {receivingNudge && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold text-white">Link staged material?</h2>
              <button onClick={closeNudge} disabled={nudgeSaving} className="text-gray-400 hover:text-white disabled:opacity-50">
                <X size={20} />
              </button>
            </div>
            <p className="text-sm text-gray-300">
              Lot <span className="font-mono text-skynet-accent">{receivingNudge.lotNumber}</span> has{' '}
              <span className="font-semibold text-white">{receivingNudge.totalBars} bars</span> already staged
              {' '}({receivingNudge.events} staging event{receivingNudge.events !== 1 ? 's' : ''}
              {receivingNudge.sampleJob ? `, e.g. ${receivingNudge.sampleJob}` : ''}). Link them to this receipt and resolve the flag?
            </p>
            {nudgeError && (
              <div className="px-3 py-2 bg-red-900/40 border border-red-700 rounded-lg text-sm text-red-300">
                {nudgeError}
              </div>
            )}
            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={closeNudge}
                disabled={nudgeSaving}
                className="px-4 py-2 text-gray-400 hover:text-white disabled:opacity-50"
              >
                Skip
              </button>
              <button
                onClick={handleNudgeLink}
                disabled={nudgeSaving}
                className="px-6 py-2 bg-skynet-accent hover:bg-skynet-accent/80 disabled:opacity-50 text-white font-medium rounded-lg transition-colors flex items-center gap-2"
              >
                {nudgeSaving && <Loader2 size={16} className="animate-spin" />}
                Link &amp; Resolve
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lot Documents Modal (after-the-fact material cert uploads) */}
      {docsModalRow && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-white">Lot Documents</h2>
                <p className="text-xs text-gray-500 mt-0.5 font-mono">
                  {docsModalRow.material_type || '—'} · {docsModalRow.bar_size || '—'} · lot {docsModalRow.lot_number || '—'}
                </p>
              </div>
              <button onClick={() => { setDocsModalRow(null); setLotDocs([]); setDocModalError('') }} className="text-gray-400 hover:text-white">
                <X size={20} />
              </button>
            </div>

            {docModalError && (
              <div className="px-3 py-2 bg-red-900/40 border border-red-700 rounded-lg text-sm text-red-300">
                {docModalError}
              </div>
            )}

            {/* Existing documents */}
            {lotDocsLoading ? (
              <div className="py-6 text-center text-gray-500 text-sm">
                <Loader2 size={20} className="animate-spin inline" />
              </div>
            ) : lotDocs.length === 0 ? (
              <p className="text-gray-500 text-sm py-2">No documents uploaded for this lot yet.</p>
            ) : (
              <ul className="space-y-2">
                {lotDocs.map(doc => (
                  <li key={doc.id} className="flex items-center justify-between gap-3 bg-gray-800 rounded-lg px-3 py-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm text-gray-200 truncate">{doc.file_name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700 text-gray-400 whitespace-nowrap">
                          {doc.document_type === 'material_cert' ? 'Material Cert' : doc.document_type === 'packing_slip' ? 'Packing Slip' : 'Other'}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600 mt-0.5">
                        {doc.uploaded_at ? new Date(doc.uploaded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : ''}
                        {doc.uploader?.full_name ? ` · ${doc.uploader.full_name}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={() => handleViewDoc(doc.file_path)}
                        className="p-1.5 text-gray-400 hover:text-skynet-accent rounded transition-colors"
                        title="View"
                      >
                        <ExternalLink size={15} />
                      </button>
                      {profile?.role === 'admin' && (
                        <button
                          onClick={() => handleDeleteLotDoc(doc)}
                          className="p-1.5 text-gray-400 hover:text-red-400 rounded transition-colors"
                          title="Delete"
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            {/* Upload more */}
            <div className="border-t border-gray-800 pt-3">
              <label className="text-xs text-gray-400 uppercase tracking-wide">Upload Documents</label>
              <input
                type="file"
                accept=".pdf,image/*"
                multiple
                disabled={docUploading}
                onChange={e => {
                  const files = Array.from(e.target.files || [])
                  e.target.value = ''
                  if (files.length) handleLotDocUpload(files)
                }}
                className="block w-full mt-1 text-sm text-gray-400 file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-gray-700 file:text-gray-200 hover:file:bg-gray-600 disabled:opacity-50"
              />
              {docUploading && (
                <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                  <Loader2 size={12} className="animate-spin" /> Uploading…
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}