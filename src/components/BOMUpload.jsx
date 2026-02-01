import { useState, useRef, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import {
  Upload,
  FileText,
  Loader2,
  CheckCircle,
  AlertTriangle,
  X,
  Package,
  Wrench,
  RefreshCw,
  Eye,
  Edit2,
  Trash2,
  Plus,
  ArrowRight,
  Check,
  AlertCircle
} from 'lucide-react'

// We'll load pdf.js and Tesseract.js from CDN for simplicity
const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
const PDFJS_WORKER_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'

// Load a script dynamically
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve()
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.onload = resolve
    script.onerror = reject
    document.head.appendChild(script)
  })
}

// Parse the OCR text to extract BOM data
function parseBOMText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0)
  
  let assemblyPartNumber = ''
  let assemblyDescription = ''
  let assemblyCost = ''
  const components = []
  let foundHeader = false
  
  // Find the assembly line - format: "SK28S3-2S - Flush Head Stud - Phillips - Stainless"
  // Also handles multi-line where "Bill of Materials" might be on same line
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    
    // Skip header lines
    if (line.includes('Skybolt Aeromotive') || line === 'Bill of Materials') continue
    
    // Find assembly part number line (starts with SK or MS pattern, followed by " - description")
    if (!assemblyPartNumber && /^[A-Z]{1,3}[\w\d/-]+\s*-\s*.+/i.test(line)) {
      const dashIdx = line.indexOf(' - ')
      if (dashIdx > 0) {
        assemblyPartNumber = line.substring(0, dashIdx).trim()
        assemblyDescription = line.substring(dashIdx + 3).trim()
      } else {
        assemblyPartNumber = line.trim()
      }
      continue
    }
    
    // Find cost line
    if (!assemblyCost && /^Cost:\s*\$[\d.]+/i.test(line)) {
      const match = line.match(/\$[\d.]+/)
      if (match) assemblyCost = match[0]
      continue
    }
    
    // Detect the header row to know when component lines start
    if (/^Item\s+Description\s+Qty/i.test(line)) {
      foundHeader = true
      continue
    }
    
    // Skip footer lines
    if (/^(February|January|March|April|May|June|July|August|September|October|November|December)/i.test(line)) continue
    if (/^Page\s+\d+/i.test(line)) continue
    
    // Only parse component rows after we've seen the header
    if (!foundHeader) continue
    
    // Parse component rows - handle OCR misreads
    // Common: "lea" instead of "1ea", "1 ea" with space, "l ea", etc.
    // Strategy: find the qty+unit pattern, then the Available number column after it
    
    // Normalize common OCR misreads: lowercase L → 1 before ea/hr/pc
    let normalized = line.replace(/\bl\s*ea\b/gi, '1 ea')
    normalized = normalized.replace(/\bl\s*hr\b/gi, '1 hr')
    normalized = normalized.replace(/\bl\s*pc\b/gi, '1 pc')
    
    // Match quantity pattern: digit(s) + space? + unit
    const qtyMatch = normalized.match(/(\d+)\s*(ea|hr|pc|lb|ft|each|pcs)\b/i)
    if (!qtyMatch) continue
    
    const qtyIdx = normalized.indexOf(qtyMatch[0])
    const beforeQty = normalized.substring(0, qtyIdx).trim()
    
    if (!beforeQty) continue
    
    // Skip labor/non-part rows
    if (/^labor\b/i.test(beforeQty)) continue
    
    // Smart split: the Item column can sometimes contain spaces (e.g., "SK203C CAGE")
    // but in most cases, the first token is the part number and the rest is description.
    // The review step allows users to correct any edge cases.
    
    // Strategy: First token = item number, rest = description
    // This is correct for the vast majority of Fishbowl BOMs
    const tokens = beforeQty.split(/\s+/)
    let itemNumber = tokens[0]
    let description = tokens.slice(1).join(' ')
    
    // If no description was parsed (single token before qty), use item as description
    if (!description) description = itemNumber
    const qtyNum = parseInt(qtyMatch[1]) || 1
    const qtyUnit = qtyMatch[2].toLowerCase()
    
    // Skip if no item number
    if (!itemNumber) continue
    
    components.push({
      part_number: itemNumber,
      description: description || itemNumber,
      quantity: qtyNum,
      unit: qtyUnit || 'ea',
      part_type: 'manufactured',  // default, user can toggle to 'purchased'
      requires_passivation: false, // default, user can toggle
      isNew: true,
      isDuplicate: false,
      existingId: null
    })
  }
  
  return {
    assembly: {
      part_number: assemblyPartNumber,
      description: assemblyDescription,
      cost: assemblyCost,
      isNew: true,
      isDuplicate: false,
      existingId: null
    },
    components
  }
}

export default function BOMUpload({ onComplete, onCancel }) {
  const [stage, setStage] = useState('upload') // upload, processing, review, saving, complete
  const [file, setFile] = useState(null)
  const [progress, setProgress] = useState('')
  const [progressPercent, setProgressPercent] = useState(0)
  const [error, setError] = useState(null)
  const [bomData, setBomData] = useState(null)
  const [editingComponent, setEditingComponent] = useState(null)
  const [editForm, setEditForm] = useState({ part_number: '', description: '' })
  const [saveResults, setSaveResults] = useState(null)
  const fileInputRef = useRef(null)
  const canvasRef = useRef(null)

  // Handle file selection
  const handleFileSelect = (e) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile)
      setError(null)
    } else {
      setError('Please select a PDF file')
    }
  }

  // Handle drag and drop
  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const droppedFile = e.dataTransfer.files?.[0]
    if (droppedFile && droppedFile.type === 'application/pdf') {
      setFile(droppedFile)
      setError(null)
    } else {
      setError('Please drop a PDF file')
    }
  }

  // Process the PDF with OCR
  const processFile = async () => {
    if (!file) return
    setStage('processing')
    setError(null)

    try {
      // Step 1: Load libraries
      setProgress('Loading OCR engine...')
      setProgressPercent(10)
      
      await loadScript(PDFJS_CDN)
      await loadScript(TESSERACT_CDN)
      
      // Configure pdf.js worker
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_CDN

      // Step 2: Read and render PDF
      setProgress('Reading PDF...')
      setProgressPercent(25)
      
      const arrayBuffer = await file.arrayBuffer()
      const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise
      const page = await pdf.getPage(1)
      
      // Render to canvas at high DPI for better OCR
      const scale = 3 // High resolution for OCR accuracy
      const viewport = page.getViewport({ scale })
      
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      const ctx = canvas.getContext('2d')
      
      await page.render({ canvasContext: ctx, viewport }).promise
      
      // Step 3: Detect orientation and rotate if needed
      setProgress('Preparing image...')
      setProgressPercent(40)
      
      // Fishbowl BOMs are landscape rotated 90° CCW
      // If width < height, the PDF is in portrait orientation but content is rotated
      // We need to rotate 90° clockwise
      let imageDataUrl
      
      if (canvas.width < canvas.height) {
        // Content is rotated - create a rotated canvas
        const rotatedCanvas = document.createElement('canvas')
        rotatedCanvas.width = canvas.height
        rotatedCanvas.height = canvas.width
        const rotCtx = rotatedCanvas.getContext('2d')
        
        rotCtx.translate(rotatedCanvas.width / 2, rotatedCanvas.height / 2)
        rotCtx.rotate(Math.PI / 2) // 90° clockwise
        rotCtx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
        
        imageDataUrl = rotatedCanvas.toDataURL('image/png')
      } else {
        imageDataUrl = canvas.toDataURL('image/png')
      }

      // Step 4: Run Tesseract OCR
      setProgress('Running OCR - extracting text...')
      setProgressPercent(55)
      
      const worker = await window.Tesseract.createWorker('eng', 1, {
        logger: (m) => {
          if (m.status === 'recognizing text') {
            const pct = Math.round(55 + (m.progress * 30))
            setProgressPercent(pct)
          }
        }
      })
      
      const { data } = await worker.recognize(imageDataUrl)
      await worker.terminate()

      // Step 5: Parse the OCR text
      setProgress('Parsing BOM data...')
      setProgressPercent(90)
      
      console.log('OCR Raw Text:', data.text)
      const parsed = parseBOMText(data.text)
      
      if (!parsed.assembly.part_number) {
        throw new Error('Could not extract assembly part number from this PDF. Please verify it is a Fishbowl Bill of Materials.')
      }
      
      if (parsed.components.length === 0) {
        throw new Error('No components found in the BOM. Please verify the PDF format.')
      }

      // Step 6: Check for duplicates in database
      setProgress('Checking for existing parts...')
      setProgressPercent(95)
      
      const allPartNumbers = [
        parsed.assembly.part_number,
        ...parsed.components.map(c => c.part_number)
      ]
      
      const { data: existingParts } = await supabase
        .from('parts')
        .select('id, part_number, description, part_type, is_active')
        .in('part_number', allPartNumbers)
      
      // Mark duplicates
      if (existingParts) {
        for (const ep of existingParts) {
          if (ep.part_number === parsed.assembly.part_number) {
            parsed.assembly.isDuplicate = true
            parsed.assembly.existingId = ep.id
            parsed.assembly.isNew = false
            parsed.assembly.existingDescription = ep.description
            parsed.assembly.existingActive = ep.is_active
          }
          for (const comp of parsed.components) {
            if (ep.part_number === comp.part_number) {
              comp.isDuplicate = true
              comp.existingId = ep.id
              comp.isNew = false
              comp.existingDescription = ep.description
              comp.existingActive = ep.is_active
            }
          }
        }
      }
      
      setProgressPercent(100)
      setBomData(parsed)
      setStage('review')
      
    } catch (err) {
      console.error('BOM processing error:', err)
      setError(err.message || 'Failed to process PDF')
      setStage('upload')
    }
  }

  // Edit a component
  const startEditComponent = (index) => {
    const comp = bomData.components[index]
    setEditingComponent(index)
    setEditForm({ part_number: comp.part_number, description: comp.description })
  }

  const saveEditComponent = () => {
    if (editingComponent === null) return
    const updated = { ...bomData }
    updated.components[editingComponent].part_number = editForm.part_number
    updated.components[editingComponent].description = editForm.description
    setBomData(updated)
    setEditingComponent(null)
  }

  // Remove a component
  const removeComponent = (index) => {
    const updated = { ...bomData }
    updated.components = updated.components.filter((_, i) => i !== index)
    setBomData(updated)
  }

  // Edit assembly info
  const [editingAssembly, setEditingAssembly] = useState(false)
  const [assemblyEditForm, setAssemblyEditForm] = useState({ part_number: '', description: '' })

  const startEditAssembly = () => {
    setAssemblyEditForm({
      part_number: bomData.assembly.part_number,
      description: bomData.assembly.description
    })
    setEditingAssembly(true)
  }

  const saveEditAssembly = () => {
    const updated = { ...bomData }
    updated.assembly.part_number = assemblyEditForm.part_number
    updated.assembly.description = assemblyEditForm.description
    setBomData(updated)
    setEditingAssembly(false)
  }

  // Save to database
  const handleSave = async () => {
    setStage('saving')
    setProgress('Creating parts and BOM...')
    const results = { created: [], linked: [], errors: [] }

    try {
      let assemblyId = bomData.assembly.existingId

      // Create or get assembly part
      if (bomData.assembly.isNew) {
        const { data: newAssembly, error: asmErr } = await supabase
          .from('parts')
          .insert({
            part_number: bomData.assembly.part_number,
            description: bomData.assembly.description,
            part_type: 'assembly',
            is_active: true
          })
          .select()
          .single()

        if (asmErr) {
          results.errors.push(`Assembly ${bomData.assembly.part_number}: ${asmErr.message}`)
        } else {
          assemblyId = newAssembly.id
          results.created.push(`Assembly: ${bomData.assembly.part_number}`)
        }
      } else {
        results.linked.push(`Assembly: ${bomData.assembly.part_number} (already exists)`)
      }

      if (!assemblyId) {
        throw new Error('Failed to create or find assembly part')
      }

      // Create or get each component
      for (const comp of bomData.components) {
        let componentId = comp.existingId

        if (comp.isNew) {
          const { data: newComp, error: compErr } = await supabase
            .from('parts')
            .insert({
              part_number: comp.part_number,
              description: comp.description,
              part_type: comp.part_type || 'manufactured',
              requires_passivation: comp.requires_passivation || false,
              is_active: true
            })
            .select()
            .single()

          if (compErr) {
            results.errors.push(`Component ${comp.part_number}: ${compErr.message}`)
            continue
          }
          componentId = newComp.id
          results.created.push(`Component: ${comp.part_number}`)
        } else {
          results.linked.push(`Component: ${comp.part_number} (already exists)`)
        }

        // Create BOM relationship (check if it already exists)
        const { data: existingBOM } = await supabase
          .from('assembly_bom')
          .select('id')
          .eq('assembly_id', assemblyId)
          .eq('component_id', componentId)
          .maybeSingle()

        if (!existingBOM) {
          const { error: bomErr } = await supabase
            .from('assembly_bom')
            .insert({
              assembly_id: assemblyId,
              component_id: componentId,
              quantity: comp.quantity,
              sort_order: bomData.components.indexOf(comp)
            })

          if (bomErr) {
            results.errors.push(`BOM link ${comp.part_number}: ${bomErr.message}`)
          } else {
            results.linked.push(`BOM: ${bomData.assembly.part_number} → ${comp.part_number}`)
          }
        } else {
          results.linked.push(`BOM link already exists: ${comp.part_number}`)
        }
      }

      setSaveResults(results)
      setStage('complete')

    } catch (err) {
      console.error('Save error:', err)
      results.errors.push(err.message)
      setSaveResults(results)
      setStage('complete')
    }
  }

  // Reset for another upload
  const handleReset = () => {
    setFile(null)
    setStage('upload')
    setProgress('')
    setProgressPercent(0)
    setError(null)
    setBomData(null)
    setSaveResults(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // =============== RENDER ===============

  // Upload Stage
  if (stage === 'upload') {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg">
          <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
            <div>
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                <Upload size={20} className="text-skynet-accent" />
                Upload Fishbowl BOM
              </h2>
              <p className="text-gray-500 text-sm mt-1">Upload a Bill of Materials PDF from Fishbowl to auto-create assembly and components</p>
            </div>
            <button onClick={onCancel} className="text-gray-400 hover:text-white">
              <X size={24} />
            </button>
          </div>

          <div className="p-6">
            {/* Drop Zone */}
            <div
              onDrop={handleDrop}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
              onDragEnter={(e) => { e.preventDefault(); e.stopPropagation() }}
              className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors cursor-pointer ${
                file ? 'border-green-600 bg-green-900/10' : 'border-gray-600 hover:border-skynet-accent bg-gray-800/30'
              }`}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                onChange={handleFileSelect}
                className="hidden"
              />
              
              {file ? (
                <div className="space-y-2">
                  <FileText size={40} className="mx-auto text-green-400" />
                  <p className="text-white font-medium">{file.name}</p>
                  <p className="text-gray-400 text-sm">{(file.size / 1024).toFixed(1)} KB</p>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleReset() }}
                    className="text-sm text-gray-400 hover:text-red-400 underline"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <Upload size={40} className="mx-auto text-gray-500" />
                  <p className="text-gray-300">Drop a Fishbowl BOM PDF here</p>
                  <p className="text-gray-500 text-sm">or click to browse</p>
                </div>
              )}
            </div>

            {error && (
              <div className="mt-4 bg-red-900/30 border border-red-700 rounded-lg p-3 flex items-center gap-2 text-red-400 text-sm">
                <AlertTriangle size={16} />
                {error}
              </div>
            )}

            <div className="mt-4 bg-gray-800/50 rounded-lg p-3 text-xs text-gray-500">
              <p className="font-medium text-gray-400 mb-1">How it works:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Upload the Fishbowl BOM PDF</li>
                <li>OCR extracts the assembly and component data</li>
                <li>Review and edit the extracted information</li>
                <li>Duplicates are automatically detected</li>
                <li>Confirm to create parts and BOM relationships</li>
              </ol>
            </div>
          </div>

          <div className="px-6 py-4 border-t border-gray-800 flex gap-3">
            <button
              onClick={onCancel}
              className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={processFile}
              disabled={!file}
              className="flex-1 py-3 bg-skynet-accent hover:bg-skynet-accent/80 disabled:bg-gray-700 disabled:text-gray-500 text-gray-900 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <ArrowRight size={20} />
              Process BOM
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Processing Stage
  if (stage === 'processing') {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg p-8">
          <div className="text-center space-y-6">
            <Loader2 size={48} className="mx-auto text-skynet-accent animate-spin" />
            <div>
              <h2 className="text-xl font-semibold text-white mb-2">Processing BOM</h2>
              <p className="text-gray-400">{progress}</p>
            </div>
            
            {/* Progress bar */}
            <div className="w-full bg-gray-800 rounded-full h-3">
              <div
                className="bg-skynet-accent h-3 rounded-full transition-all duration-500"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <p className="text-gray-500 text-sm">{progressPercent}%</p>
          </div>
        </div>
      </div>
    )
  }

  // Review Stage
  if (stage === 'review' && bomData) {
    const newCount = [bomData.assembly, ...bomData.components].filter(p => p.isNew).length
    const existingCount = [bomData.assembly, ...bomData.components].filter(p => p.isDuplicate).length

    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between flex-shrink-0">
            <div>
              <h2 className="text-xl font-semibold text-white flex items-center gap-2">
                <Eye size={20} className="text-skynet-accent" />
                Review Extracted BOM
              </h2>
              <p className="text-gray-500 text-sm mt-1">
                Verify the data below before importing
              </p>
            </div>
            <button onClick={onCancel} className="text-gray-400 hover:text-white">
              <X size={24} />
            </button>
          </div>

          {/* Summary badges */}
          <div className="px-6 py-3 border-b border-gray-800 flex gap-3 flex-shrink-0">
            <span className="text-xs px-2 py-1 rounded bg-green-900/50 text-green-400 border border-green-700">
              {newCount} new part{newCount !== 1 ? 's' : ''} to create
            </span>
            {existingCount > 0 && (
              <span className="text-xs px-2 py-1 rounded bg-yellow-900/50 text-yellow-400 border border-yellow-700">
                {existingCount} already exist{existingCount === 1 ? 's' : ''}
              </span>
            )}
            <span className="text-xs px-2 py-1 rounded bg-blue-900/50 text-blue-400 border border-blue-700">
              {bomData.components.length} component{bomData.components.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Scrollable Content */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {/* Assembly */}
            <div className={`border rounded-lg overflow-hidden ${
              bomData.assembly.isDuplicate 
                ? 'border-yellow-700 bg-yellow-900/10' 
                : 'border-skynet-accent/50 bg-skynet-accent/5'
            }`}>
              <div className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Package size={20} className="text-skynet-accent" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-white font-mono font-medium text-lg">
                        {bomData.assembly.part_number}
                      </span>
                      <span className="text-xs px-1.5 py-0.5 rounded bg-skynet-accent/20 text-skynet-accent">
                        ASSEMBLY
                      </span>
                      {bomData.assembly.isDuplicate && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-400 border border-yellow-700">
                          EXISTS IN DB
                        </span>
                      )}
                    </div>
                    {editingAssembly ? (
                      <div className="mt-2 flex gap-2">
                        <input
                          value={assemblyEditForm.part_number}
                          onChange={(e) => setAssemblyEditForm({...assemblyEditForm, part_number: e.target.value})}
                          className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm font-mono"
                          placeholder="Part Number"
                        />
                        <input
                          value={assemblyEditForm.description}
                          onChange={(e) => setAssemblyEditForm({...assemblyEditForm, description: e.target.value})}
                          className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm flex-1"
                          placeholder="Description"
                        />
                        <button onClick={saveEditAssembly} className="p-1 text-green-400 hover:text-green-300">
                          <Check size={16} />
                        </button>
                        <button onClick={() => setEditingAssembly(false)} className="p-1 text-gray-400 hover:text-gray-300">
                          <X size={16} />
                        </button>
                      </div>
                    ) : (
                      <p className="text-gray-400 text-sm">{bomData.assembly.description}</p>
                    )}
                    {bomData.assembly.isDuplicate && bomData.assembly.existingDescription && (
                      <p className="text-yellow-500/70 text-xs mt-1">
                        DB description: {bomData.assembly.existingDescription}
                      </p>
                    )}
                  </div>
                </div>
                {!editingAssembly && (
                  <button onClick={startEditAssembly} className="p-2 text-gray-400 hover:text-white">
                    <Edit2 size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* Components */}
            <div className="space-y-1">
              <div className="flex items-center gap-2 mb-3">
                <Wrench size={16} className="text-gray-400" />
                <span className="text-gray-400 text-sm font-medium">Components ({bomData.components.length})</span>
              </div>
              
              {bomData.components.map((comp, idx) => (
                <div
                  key={idx}
                  className={`border rounded-lg px-4 py-3 ${
                    comp.isDuplicate
                      ? 'border-yellow-700/50 bg-yellow-900/5'
                      : 'border-gray-700 bg-gray-800/30'
                  }`}
                >
                  {editingComponent === idx ? (
                    <div className="flex gap-2 flex-1 mr-2">
                      <input
                        value={editForm.part_number}
                        onChange={(e) => setEditForm({...editForm, part_number: e.target.value})}
                        className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm font-mono w-40"
                        placeholder="Part Number"
                      />
                      <input
                        value={editForm.description}
                        onChange={(e) => setEditForm({...editForm, description: e.target.value})}
                        className="px-2 py-1 bg-gray-800 border border-gray-600 rounded text-white text-sm flex-1"
                        placeholder="Description"
                      />
                      <button onClick={saveEditComponent} className="p-1 text-green-400 hover:text-green-300">
                        <Check size={16} />
                      </button>
                      <button onClick={() => setEditingComponent(null)} className="p-1 text-gray-400 hover:text-gray-300">
                        <X size={16} />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        <div className="w-6 h-6 rounded bg-gray-700 flex items-center justify-center text-xs text-gray-400 flex-shrink-0">
                          {idx + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-gray-300 font-mono text-sm">{comp.part_number}</span>
                            {comp.isDuplicate && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-yellow-900/50 text-yellow-400 border border-yellow-700">
                                EXISTS
                              </span>
                            )}
                            {comp.isNew && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-green-900/50 text-green-400 border border-green-700">
                                NEW
                              </span>
                            )}
                          </div>
                          <p className="text-gray-500 text-xs truncate">{comp.description}</p>
                          {comp.isDuplicate && comp.existingDescription && (
                            <p className="text-yellow-500/60 text-xs">DB: {comp.existingDescription}</p>
                          )}
                        </div>
                        <span className="text-gray-500 text-sm flex-shrink-0 mr-2">×{comp.quantity}</span>
                      </div>
                      <div className="flex items-center gap-1 ml-2">
                        <button onClick={() => startEditComponent(idx)} className="p-1.5 text-gray-500 hover:text-white">
                          <Edit2 size={14} />
                        </button>
                        <button onClick={() => removeComponent(idx)} className="p-1.5 text-gray-500 hover:text-red-400">
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  )}
                  
                  {/* Part Type + Passivation row - always visible */}
                  {editingComponent !== idx && (
                    <div className="flex items-center gap-4 mt-2 pt-2 border-t border-gray-700/50 pl-9">
                      {/* Manufactured / Purchased toggle */}
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-500 text-xs">Type:</span>
                        <button
                          onClick={() => {
                            const updated = { ...bomData }
                            updated.components[idx].part_type = 
                              updated.components[idx].part_type === 'manufactured' ? 'purchased' : 'manufactured'
                            setBomData({ ...updated })
                          }}
                          className={`text-xs px-2 py-0.5 rounded-full font-medium transition-colors ${
                            comp.part_type === 'manufactured'
                              ? 'bg-blue-900/50 text-blue-400 border border-blue-700'
                              : 'bg-orange-900/50 text-orange-400 border border-orange-700'
                          }`}
                        >
                          {comp.part_type === 'manufactured' ? '⚙ Manufactured' : '📦 Purchased'}
                        </button>
                      </div>

                      {/* Requires Passivation checkbox */}
                      <label className="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={comp.requires_passivation || false}
                          onChange={(e) => {
                            const updated = { ...bomData }
                            updated.components[idx].requires_passivation = e.target.checked
                            setBomData({ ...updated })
                          }}
                          className="w-3.5 h-3.5 rounded border-gray-600 bg-gray-800 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-0"
                        />
                        <span className={`text-xs ${comp.requires_passivation ? 'text-cyan-400' : 'text-gray-500'}`}>
                          Requires Passivation
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Info box about duplicates */}
            {existingCount > 0 && (
              <div className="bg-yellow-900/20 border border-yellow-700/50 rounded-lg p-4 text-sm">
                <div className="flex items-start gap-2">
                  <AlertCircle size={16} className="text-yellow-400 mt-0.5 flex-shrink-0" />
                  <div className="text-yellow-400/90">
                    <p className="font-medium">Parts already in database</p>
                    <p className="text-yellow-500/70 mt-1">
                      Existing parts will be linked to this assembly's BOM without creating duplicates. 
                      Only new parts (marked green) will be created.
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-gray-800 flex gap-3 flex-shrink-0">
            <button
              onClick={handleReset}
              className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors"
            >
              Start Over
            </button>
            <button
              onClick={handleSave}
              className="flex-1 py-3 bg-green-600 hover:bg-green-500 text-white font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <CheckCircle size={20} />
              Import BOM ({newCount} new, {existingCount} existing)
            </button>
          </div>
        </div>
      </div>
    )
  }

  // Saving Stage
  if (stage === 'saving') {
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg p-8">
          <div className="text-center space-y-4">
            <Loader2 size={48} className="mx-auto text-green-400 animate-spin" />
            <h2 className="text-xl font-semibold text-white">Importing BOM Data</h2>
            <p className="text-gray-400">{progress}</p>
          </div>
        </div>
      </div>
    )
  }

  // Complete Stage
  if (stage === 'complete' && saveResults) {
    const hasErrors = saveResults.errors.length > 0
    
    return (
      <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg max-h-[80vh] flex flex-col">
          <div className="px-6 py-4 border-b border-gray-800 flex-shrink-0">
            <h2 className="text-xl font-semibold text-white flex items-center gap-2">
              {hasErrors ? (
                <AlertTriangle size={20} className="text-yellow-400" />
              ) : (
                <CheckCircle size={20} className="text-green-400" />
              )}
              {hasErrors ? 'Import Completed with Warnings' : 'BOM Import Successful!'}
            </h2>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-4">
            {saveResults.created.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-green-400 mb-2 flex items-center gap-1">
                  <Plus size={14} /> Created ({saveResults.created.length})
                </h3>
                <div className="space-y-1">
                  {saveResults.created.map((item, i) => (
                    <div key={i} className="text-sm text-gray-300 bg-green-900/10 border border-green-900/30 rounded px-3 py-1.5">
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {saveResults.linked.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-blue-400 mb-2 flex items-center gap-1">
                  <ArrowRight size={14} /> Linked ({saveResults.linked.length})
                </h3>
                <div className="space-y-1">
                  {saveResults.linked.map((item, i) => (
                    <div key={i} className="text-sm text-gray-400 bg-blue-900/10 border border-blue-900/30 rounded px-3 py-1.5">
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {saveResults.errors.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-red-400 mb-2 flex items-center gap-1">
                  <AlertTriangle size={14} /> Errors ({saveResults.errors.length})
                </h3>
                <div className="space-y-1">
                  {saveResults.errors.map((item, i) => (
                    <div key={i} className="text-sm text-red-300 bg-red-900/10 border border-red-900/30 rounded px-3 py-1.5">
                      {item}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-gray-800 flex gap-3 flex-shrink-0">
            <button
              onClick={handleReset}
              className="flex-1 py-3 bg-gray-800 hover:bg-gray-700 text-white rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <Upload size={18} />
              Upload Another
            </button>
            <button
              onClick={() => onComplete?.()}
              className="flex-1 py-3 bg-skynet-accent hover:bg-skynet-accent/80 text-gray-900 font-semibold rounded-lg transition-colors flex items-center justify-center gap-2"
            >
              <Check size={18} />
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  return null
}