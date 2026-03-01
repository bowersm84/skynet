import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
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
  Route
} from 'lucide-react'
import BOMUpload from '../components/BOMUpload'
import RoutingTemplatesTab from '../components/RoutingTemplatesTab'

export default function MasterData({ profile }) {
  const [activeTab, setActiveTab] = useState('assemblies')
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  
  // Data
  const [parts, setParts] = useState([])
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
    drawing_revision: ''
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

  // Document requirements for part modal
  const [documentTypes, setDocumentTypes] = useState([])
  const [docRequirements, setDocRequirements] = useState([])
  const [showDocRequirements, setShowDocRequirements] = useState(false)

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
              requires_passivation
            )
          )
        `)
        .eq('is_active', true)
        .order('part_number')

      if (partsError) throw partsError
      setParts(partsData || [])

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

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // Filter parts based on search and tab
  const filteredParts = parts.filter(p => {
    const matchesSearch = 
      p.part_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(searchQuery.toLowerCase())
    
    if (activeTab === 'assemblies') {
      return matchesSearch && (p.part_type === 'assembly' || p.part_type === 'finished_good')
    } else if (activeTab === 'components') {
      return matchesSearch && p.part_type !== 'assembly' && p.part_type !== 'finished_good'
    }
    return matchesSearch
  })

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
        drawing_revision: part.drawing_revision || ''
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
      setPartForm({
        part_number: '',
        description: '',
        part_type: activeTab === 'assemblies' ? 'assembly' : 'manufactured',
        customer: '',
        specification: '',
        requires_passivation: false,
        unit_cost: 0,
        material_type_id: null,
        drawing_revision: ''
      })
      setRoutingSteps([])
      setDocRequirements([])
      setShowDocRequirements(false)
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

    // Routing is mandatory for manufactured and finished_good parts
    const needsRouting = partForm.part_type === 'manufactured' || partForm.part_type === 'finished_good'
    if (needsRouting && routingSteps.length === 0) {
      alert('Routing is required — add at least one step')
      return
    }
    if (needsRouting && routingSteps.some(s => !s.step_name.trim())) {
      alert('All routing steps must have a name')
      return
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
            drawing_revision: partForm.drawing_revision?.trim() || null
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 size={32} className="animate-spin text-skynet-accent" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <div className="border-b border-gray-800 bg-gray-900">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Database className="text-skynet-accent" size={28} />
              <div>
                <h1 className="text-xl font-bold">Master Data</h1>
                <p className="text-gray-500 text-sm">Manage parts, assemblies, and materials</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-800 bg-gray-900/50">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex gap-1">
            {[
              { id: 'assemblies', label: 'Finished Products', icon: Package, count: parts.filter(p => p.part_type === 'assembly' || p.part_type === 'finished_good').length },
              { id: 'components', label: 'Components', icon: Wrench, count: parts.filter(p => p.part_type !== 'assembly' && p.part_type !== 'finished_good').length },
              { id: 'materials', label: 'Materials', icon: Layers, count: materialTypes.length },
              { id: 'barsizes', label: 'Bar Sizes', icon: Database, count: barSizes.length },
              { id: 'routing', label: 'Routing Templates', icon: Route, count: routingTemplates.length }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-skynet-accent text-skynet-accent'
                    : 'border-transparent text-gray-400 hover:text-white'
                }`}
              >
                <tab.icon size={16} />
                {tab.label}
                <span className={`px-1.5 py-0.5 text-xs rounded ${
                  activeTab === tab.id ? 'bg-skynet-accent/20' : 'bg-gray-800'
                }`}>
                  {tab.count}
                </span>
              </button>
            ))}
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
              <div className="flex items-center gap-2">
                {activeTab === 'assemblies' && (
                  <button
                    onClick={() => setShowBOMUpload(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-green-700 hover:bg-green-600 text-white font-medium rounded-lg transition-colors"
                  >
                    <Upload size={18} />
                    Upload BOM
                  </button>
                )}
                <button
                  onClick={() => openPartModal()}
                  className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded-lg transition-colors"
                >
                  <Plus size={18} />
                  Add {activeTab === 'assemblies' ? 'Finished Product' : 'Component'}
                </button>
              </div>
            </div>

            {/* Parts List */}
            {filteredParts.length === 0 ? (
              <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
                <Package size={48} className="mx-auto text-gray-600 mb-3" />
                <p className="text-gray-400">No {activeTab} found</p>
                <p className="text-gray-600 text-sm mt-1">Click "Add" to create one</p>
              </div>
            ) : (
              <div className="space-y-2">
                {filteredParts.map(part => (
                  <div
                    key={part.id}
                    className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 hover:border-gray-600 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-skynet-accent font-mono font-medium">{part.part_number}</span>
                          {part.part_type === 'assembly' && (
                            <span className="text-xs px-2 py-0.5 bg-purple-900/50 text-purple-300 rounded border border-purple-700/50">Assembly</span>
                          )}
                          {part.part_type === 'finished_good' && (
                            <span className="text-xs px-2 py-0.5 bg-emerald-900/50 text-emerald-300 rounded border border-emerald-700/50">Finished Good</span>
                          )}
                          {part.requires_passivation && (
                            <span className="text-xs px-2 py-0.5 bg-cyan-900/50 text-cyan-300 rounded flex items-center gap-1">
                              <Beaker size={10} />
                              Passivation
                            </span>
                          )}
                          {part.part_type === 'purchased' && (
                            <span className="text-xs px-2 py-0.5 bg-orange-900/50 text-orange-300 rounded border border-orange-700/50 flex items-center gap-1">
                              📦 Purchased
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
                              BOM Components ({part.assembly_bom.length}):
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
              <button
                onClick={() => openMaterialModal()}
                className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded-lg transition-colors"
              >
                <Plus size={18} />
                Add Material
              </button>
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
              <button
                onClick={() => openBarSizeModal()}
                className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded-lg transition-colors"
              >
                <Plus size={18} />
                Add Bar Size
              </button>
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
      </div>

      {/* Part Modal */}
      {showPartModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
              <h2 className="text-lg font-semibold text-white">
                {editingPart ? 'Edit Part' : `New ${
                  partForm.part_type === 'assembly' ? 'Assembly' :
                  partForm.part_type === 'finished_good' ? 'Finished Good' : 'Component'
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
                    onChange={(e) => setPartForm({ ...partForm, part_type: e.target.value })}
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white focus:outline-none focus:border-skynet-accent"
                  >
                    <option value="assembly">Assembly (has BOM)</option>
                    <option value="finished_good">Finished Good (no assembly)</option>
                    <option value="manufactured">Manufactured Component</option>
                    <option value="purchased">Purchased Component</option>
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
                    <span className="text-white">Requires Passivation</span>
                  </div>
                </label>
              )}

              {/* Routing Steps — for manufactured/finished_good */}
              {partForm.part_type !== 'assembly' && partForm.part_type !== 'purchased' && (
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
                          {routingTemplates.map(t => (
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
                        <div key={idx} className="bg-gray-800 rounded-lg p-3 border border-gray-700">
                          <div className="flex items-center gap-2">
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
                <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
                  Current Components ({bomComponents.length})
                </h3>
                {bomComponents.length === 0 ? (
                  <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-6 text-center">
                    <p className="text-gray-500">No components added yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {bomComponents.map(bom => (
                      <div
                        key={bom.id}
                        className="bg-gray-800 border border-gray-700 rounded-lg p-3 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3">
                          <Wrench size={16} className="text-gray-500" />
                          <div>
                            <span className="text-skynet-accent font-mono">{bom.component?.part_number}</span>
                            <span className="text-gray-500 ml-2">{bom.component?.description}</span>
                            {bom.component?.requires_passivation && (
                              <span className="ml-2 text-xs text-cyan-400">
                                <Beaker size={10} className="inline" /> Passivation
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-3">
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
                            onClick={() => removeFromBOM(bom.id)}
                            className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add Components */}
              <div>
                <h3 className="text-sm font-medium text-gray-400 uppercase tracking-wide mb-3">
                  Add Components
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
                      All available components have been added
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
    </div>
  )
}