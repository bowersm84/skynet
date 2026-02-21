import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import {
  Plus, Edit2, Trash2, X, Loader2, Check,
  ChevronUp, ChevronDown, Route
} from 'lucide-react'

export default function RoutingTemplatesTab({ onDataChange }) {
  const [templates, setTemplates] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(null)

  // Modal state
  const [showModal, setShowModal] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState(null)
  const [form, setForm] = useState({ name: '', description: '', material_category: '' })
  const [steps, setSteps] = useState([])

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase
      .from('routing_templates')
      .select(`
        *,
        routing_template_steps(*)
      `)
      .eq('is_active', true)
      .order('name')

    if (!error) {
      const sorted = (data || []).map(t => ({
        ...t,
        routing_template_steps: (t.routing_template_steps || [])
          .sort((a, b) => a.step_order - b.step_order)
      }))
      setTemplates(sorted)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const openModal = (template = null) => {
    if (template) {
      setEditingTemplate(template)
      setForm({
        name: template.name,
        description: template.description || '',
        material_category: template.material_category || ''
      })
      setSteps(
        (template.routing_template_steps || [])
          .sort((a, b) => a.step_order - b.step_order)
          .map(s => ({
            step_name: s.step_name,
            step_type: s.step_type || 'internal',
            default_station: s.default_station || '',
            notes: s.notes || ''
          }))
      )
    } else {
      setEditingTemplate(null)
      setForm({ name: '', description: '', material_category: '' })
      setSteps([])
    }
    setShowModal(true)
  }

  const addStep = () => {
    setSteps([...steps, { step_name: '', step_type: 'internal', default_station: '', notes: '' }])
  }

  const removeStep = (index) => {
    setSteps(steps.filter((_, i) => i !== index))
  }

  const moveStep = (index, direction) => {
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= steps.length) return
    const updated = [...steps]
    const [moved] = updated.splice(index, 1)
    updated.splice(newIndex, 0, moved)
    setSteps(updated)
  }

  const updateStep = (index, field, value) => {
    const updated = [...steps]
    updated[index] = { ...updated[index], [field]: value }
    setSteps(updated)
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      alert('Template name is required')
      return
    }
    if (steps.length === 0) {
      alert('Add at least one routing step')
      return
    }
    if (steps.some(s => !s.step_name.trim())) {
      alert('All steps must have a name')
      return
    }

    setSaving(true)
    try {
      let templateId = editingTemplate?.id

      if (editingTemplate) {
        const { error } = await supabase
          .from('routing_templates')
          .update({
            name: form.name.trim(),
            description: form.description.trim() || null,
            material_category: form.material_category.trim() || null,
            updated_at: new Date().toISOString()
          })
          .eq('id', editingTemplate.id)
        if (error) throw error
      } else {
        const { data, error } = await supabase
          .from('routing_templates')
          .insert({
            name: form.name.trim(),
            description: form.description.trim() || null,
            material_category: form.material_category.trim() || null
          })
          .select()
          .single()
        if (error) throw error
        templateId = data.id
      }

      // Delete existing steps and re-insert (simplest for reorder support)
      if (editingTemplate) {
        await supabase
          .from('routing_template_steps')
          .delete()
          .eq('template_id', templateId)
      }

      // Insert steps in order
      for (let i = 0; i < steps.length; i++) {
        const { error: stepErr } = await supabase
          .from('routing_template_steps')
          .insert({
            template_id: templateId,
            step_order: i + 1,
            step_name: steps[i].step_name.trim(),
            step_type: steps[i].step_type,
            default_station: steps[i].default_station.trim() || null,
            notes: steps[i].notes.trim() || null
          })
        if (stepErr) throw stepErr
      }

      setShowModal(false)
      await fetchTemplates()
      onDataChange?.()
    } catch (err) {
      console.error('Error saving routing template:', err)
      alert('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (templateId) => {
    if (!confirm('Are you sure you want to delete this routing template?')) return

    setDeleting(templateId)
    try {
      const { error } = await supabase
        .from('routing_templates')
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq('id', templateId)
      if (error) throw error
      await fetchTemplates()
      onDataChange?.()
    } catch (err) {
      console.error('Error deleting template:', err)
      alert('Failed to delete: ' + err.message)
    } finally {
      setDeleting(null)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-40">
        <Loader2 size={24} className="animate-spin text-skynet-accent" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-gray-400">Manage routing templates for manufacturing processes</p>
        <button
          onClick={() => openModal()}
          className="flex items-center gap-2 px-4 py-2 bg-skynet-accent hover:bg-blue-600 text-white font-medium rounded-lg transition-colors"
        >
          <Plus size={18} />
          New Template
        </button>
      </div>

      {templates.length === 0 ? (
        <div className="bg-gray-800/30 border border-gray-700 rounded-lg p-12 text-center">
          <Route size={48} className="mx-auto text-gray-600 mb-3" />
          <p className="text-gray-400">No routing templates defined</p>
          <p className="text-gray-600 text-sm mt-1">Create a template to define standard manufacturing routes</p>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map(template => (
            <div
              key={template.id}
              className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 hover:border-gray-600 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-white font-medium">{template.name}</span>
                    {template.material_category && (
                      <span className="text-xs px-2 py-0.5 bg-blue-900/40 text-blue-300 rounded border border-blue-800/50">
                        {template.material_category}
                      </span>
                    )}
                  </div>
                  {template.description && (
                    <p className="text-gray-500 text-sm">{template.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openModal(template)}
                    className="p-1.5 text-gray-400 hover:text-white hover:bg-gray-700 rounded"
                    title="Edit"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(template.id)}
                    disabled={deleting === template.id}
                    className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/20 rounded disabled:opacity-50"
                    title="Delete"
                  >
                    {deleting === template.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </div>
              </div>

              {/* Steps preview */}
              <div className="flex items-center gap-1 flex-wrap">
                {template.routing_template_steps.map((step, idx) => (
                  <div key={step.id} className="flex items-center gap-1">
                    {idx > 0 && <span className="text-gray-600 text-sm">&rarr;</span>}
                    <span className={`text-xs px-2 py-1 rounded border ${
                      step.step_type === 'external'
                        ? 'bg-orange-900/30 text-orange-300 border-orange-800/50'
                        : 'bg-gray-700 text-gray-300 border-gray-600'
                    }`}>
                      {step.step_name}
                      {step.default_station && (
                        <span className="text-gray-500 ml-1">({step.default_station})</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Template Modal */}
      {showModal && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setShowModal(false)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-xl max-h-[85vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
              <h2 className="text-lg font-semibold text-white">
                {editingTemplate ? 'Edit Routing Template' : 'New Routing Template'}
              </h2>
              <button onClick={() => setShowModal(false)} className="text-gray-400 hover:text-white">
                <X size={24} />
              </button>
            </div>

            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-gray-400 text-sm mb-1">Template Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g., Stainless"
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Description</label>
                  <input
                    type="text"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Optional description"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                  />
                </div>
                <div>
                  <label className="block text-gray-400 text-sm mb-1">Material Category</label>
                  <input
                    type="text"
                    value={form.material_category}
                    onChange={(e) => setForm({ ...form, material_category: e.target.value })}
                    placeholder="e.g., Stainless Steel"
                    className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                  />
                </div>
              </div>

              {/* Steps Management */}
              <div className="border border-gray-700 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-gray-400 text-sm font-medium">Routing Steps ({steps.length})</p>
                  <button
                    type="button"
                    onClick={addStep}
                    className="flex items-center gap-1 text-xs text-skynet-accent hover:text-blue-400 transition-colors"
                  >
                    <Plus size={14} />
                    Add Step
                  </button>
                </div>

                {steps.length === 0 ? (
                  <p className="text-gray-600 text-sm text-center py-4">
                    No steps added yet &mdash; click &ldquo;Add Step&rdquo; to begin
                  </p>
                ) : (
                  <div className="space-y-2">
                    {steps.map((step, idx) => (
                      <div key={idx} className="bg-gray-800 rounded-lg p-3 border border-gray-700">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="text-gray-500 text-xs font-mono w-5 text-center">{idx + 1}</span>
                          <input
                            type="text"
                            value={step.step_name}
                            onChange={(e) => updateStep(idx, 'step_name', e.target.value)}
                            placeholder="Step name *"
                            className="flex-1 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                          />
                          <select
                            value={step.step_type}
                            onChange={(e) => updateStep(idx, 'step_type', e.target.value)}
                            className="px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:border-skynet-accent"
                          >
                            <option value="internal">Internal</option>
                            <option value="external">External</option>
                          </select>
                          <input
                            type="text"
                            value={step.default_station}
                            onChange={(e) => updateStep(idx, 'default_station', e.target.value)}
                            placeholder="Station"
                            className="w-28 px-2 py-1 bg-gray-700 border border-gray-600 rounded text-white text-sm placeholder-gray-500 focus:outline-none focus:border-skynet-accent"
                          />
                        </div>
                        <div className="flex items-center justify-between pl-7">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => moveStep(idx, -1)}
                              disabled={idx === 0}
                              className="p-1 text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Move up"
                            >
                              <ChevronUp size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveStep(idx, 1)}
                              disabled={idx === steps.length - 1}
                              className="p-1 text-gray-500 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Move down"
                            >
                              <ChevronDown size={14} />
                            </button>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeStep(idx)}
                            className="p-1 text-red-400 hover:text-red-300"
                            title="Remove step"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="px-6 py-4 border-t border-gray-800 flex gap-3 flex-shrink-0">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
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
    </div>
  )
}
