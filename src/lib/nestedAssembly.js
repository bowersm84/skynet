//
// Nested Assembly — shared helpers for exploding a multi-level BOM and
// consuming the result in Create WO (tree render in B1, recursive submit in B2).
// Gated behind FEATURES.NESTED_ASSEMBLY at the call sites.
//
import { supabase } from './supabase'

// Stable per-node key: path is the array of part_ids from the root down to this
// node, so it is unique even when the same part appears under two parents.
export function pathKey(node) {
  return (node.path || []).join('>')
}

// Fetch the full BOM tree for a top assembly via the explode_bom RPC.
// Always called with top qty = 1; cumulative_quantity is then the per-finished-
// assembly multiplier for each node, and callers multiply by (order + stock).
export async function fetchExplodedBom(topPartId) {
  if (!topPartId) return { nodes: [], error: null }
  const { data, error } = await supabase.rpc('explode_bom', {
    p_part_id: topPartId,
    p_top_qty: 1,
  })
  if (error) {
    console.error('explode_bom failed:', error)
    return { nodes: [], error }
  }
  return { nodes: data || [], error: null }
}

// Convert the flat path-rows from explode_bom into a nested tree for rendering.
// Each node: { key, componentId, partNumber, description, partType, sortOrder,
//   bomQuantity, unitQty (cumulative at top=1), depth, isCycle, children: [] }.
export function buildBomTree(nodes) {
  const byKey = new Map()
  const roots = []

  for (const n of nodes) {
    byKey.set(pathKey(n), {
      key: pathKey(n),
      componentId: n.component_id,
      partNumber: n.part_number,
      description: n.description,
      partType: n.part_type,
      sortOrder: n.sort_order ?? 0,
      bomQuantity: n.bom_quantity,
      unitQty: n.cumulative_quantity, // top qty was 1
      depth: n.depth,
      isCycle: n.is_cycle,
      children: [],
    })
  }

  for (const n of nodes) {
    const node = byKey.get(pathKey(n))
    const parentPath = (n.path || []).slice(0, -1)
    if (parentPath.length === 0) {
      roots.push(node)
    } else {
      const parent = byKey.get(parentPath.join('>'))
      if (parent) parent.children.push(node)
      else roots.push(node) // defensive: orphan (shouldn't happen)
    }
  }

  const sortRec = (list) => {
    list.sort((a, b) => (a.sortOrder - b.sortOrder) || a.partNumber.localeCompare(b.partNumber))
    list.forEach(c => sortRec(c.children))
  }
  sortRec(roots)
  return roots
}

// Keys of every selectable leaf (manufactured parts — the only nodes that become jobs).
export function manufacturedLeafKeys(roots) {
  const keys = []
  const walk = (list) => {
    for (const n of list) {
      if (n.partType === 'manufactured') keys.push(n.key)
      walk(n.children)
    }
  }
  walk(roots)
  return keys
}

// --- B2: recursive submit ---------------------------------------------------

// Copy a part's active routing steps onto a work_order_assembly (plain — the
// nested tree has no per-node route editing, so no removals/additions).
async function copyAssemblyRoutingPlain(assemblyId, woaId) {
  const { data: steps } = await supabase
    .from('part_routing_steps')
    .select('*')
    .eq('part_id', assemblyId)
    .eq('is_active', true)
    .order('step_order')
  if (!steps || steps.length === 0) return
  const rows = steps.map(step => ({
    work_order_assembly_id: woaId,
    step_order: step.step_order,
    step_name: step.step_name,
    step_type: step.step_type,
    station: step.default_station,
    status: 'pending',
  }))
  const { error } = await supabase.from('work_order_assembly_routing_steps').insert(rows)
  if (error) console.error('Nested sub-woa routing copy failed:', error)
}

// Copy a component's active routing steps + current documents onto a new job
// (mirrors the single-level submit's job routing + part-doc pull-forward).
async function copyJobRoutingAndDocs(componentId, jobId, profileId) {
  const { data: steps } = await supabase
    .from('part_routing_steps')
    .select('*')
    .eq('part_id', componentId)
    .eq('is_active', true)
    .order('step_order')
  if (steps && steps.length > 0) {
    const rows = steps.map(step => ({
      job_id: jobId,
      step_order: step.step_order,
      step_name: step.step_name,
      step_type: step.step_type,
      station: step.default_station,
      status: 'pending',
    }))
    const { error } = await supabase.from('job_routing_steps').insert(rows)
    if (error) console.error('Nested job routing copy failed:', error)
  }

  const { data: partDocs } = await supabase
    .from('part_documents')
    .select('document_type_id, file_name, file_url, file_size, mime_type')
    .eq('part_id', componentId)
    .eq('is_current', true)
  if (partDocs && partDocs.length > 0) {
    const docRows = partDocs.map(pd => ({
      job_id: jobId,
      document_type_id: pd.document_type_id,
      file_name: pd.file_name,
      file_url: pd.file_url,
      file_size: pd.file_size,
      mime_type: pd.mime_type,
      uploaded_by: profileId,
      status: 'approved',
      source: 'part_pulled_forward',
    }))
    const { error } = await supabase.from('job_documents').insert(docRows)
    if (error) console.error('Nested job part-doc pull-forward failed:', error)
  }
}

// Recursively create the sub-assembly woas and component jobs below an already-
// created top woa. Walks the explode_bom tree (built at top qty 1) and multiplies
// each node's unit qty by `multiplier` (top order + stock). Pre-order DFS so a
// parent woa always exists before its children attach. Returns the next available
// J-number after creating all jobs.
export async function submitNestedTree({
  workOrderId,
  topWoaId,
  treeNodes,
  selectedKeys,
  multiplier,
  profileId,
  startJobNum,
}) {
  const roots = buildBomTree(treeNodes)
  const woaIdByPath = new Map() // pathKey -> created woa id

  const enclosingWoaId = (node) => {
    const parentPath = node.key.split('>').slice(0, -1)
    if (parentPath.length === 0) return topWoaId
    return woaIdByPath.get(parentPath.join('>')) || topWoaId
  }

  let jobNum = startJobNum

  const visit = async (node) => {
    if (node.isCycle) return

    if (node.partType === 'assembly' || node.partType === 'finished_good') {
      const parentWoaId = enclosingWoaId(node)
      const subQty = (node.unitQty || 0) * (multiplier || 0)
      const { data: subWoa, error } = await supabase
        .from('work_order_assemblies')
        .insert({
          work_order_id: workOrderId,
          assembly_id: node.componentId,
          parent_work_order_assembly_id: parentWoaId,
          quantity: subQty,
          order_quantity: subQty, // sub-levels are demand-driven; no separate stock
          stock_quantity: null,
          status: 'pending',
        })
        .select('id')
        .single()
      if (error || !subWoa) {
        console.error('Nested sub-woa insert failed:', error)
        return
      }
      woaIdByPath.set(node.key, subWoa.id)
      await copyAssemblyRoutingPlain(node.componentId, subWoa.id)
      for (const child of node.children) await visit(child)
      return
    }

    if (node.partType === 'manufactured') {
      if (!selectedKeys[node.key]) return
      const woaId = enclosingWoaId(node)
      const qty = (node.unitQty || 0) * (multiplier || 0)
      const { data: newJob, error } = await supabase
        .from('jobs')
        .insert({
          job_number: `J-${String(jobNum++).padStart(6, '0')}`,
          work_order_id: workOrderId,
          work_order_assembly_id: woaId,
          component_id: node.componentId,
          quantity: qty,
          status: 'pending_compliance',
          is_maintenance: false,
        })
        .select('id')
        .single()
      if (error || !newJob) {
        console.error('Nested job insert failed:', error)
        return
      }
      await copyJobRoutingAndDocs(node.componentId, newJob.id, profileId)
      return
    }
    // purchased: nothing to create
  }

  for (const root of roots) await visit(root)
  return jobNum
}
