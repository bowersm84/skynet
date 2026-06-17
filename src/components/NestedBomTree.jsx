import { useState } from 'react'
import { Wrench, ShoppingCart, Layers, ChevronRight, ChevronDown, AlertTriangle, Loader2 } from 'lucide-react'
import { buildBomTree } from '../lib/nestedAssembly'

// Multi-level BOM tree for an assembly in Create WO.
//  - assembly / finished_good nodes: collapsible sub-assembly groups
//  - manufactured leaves: toggle buttons that become jobs
//  - purchased leaves: shown for context (no job)
//  - cycle nodes: flagged, not expanded
// Props:
//   topQty        number               order + stock at the top assembly
//   treeState     { loading, nodes, error }
//   selected      { [nodeKey]: true }  selected manufactured-leaf keys
//   onToggleLeaf  (node) => void
export default function NestedBomTree({ topQty, treeState, selected, onToggleLeaf }) {
  const [collapsed, setCollapsed] = useState({})

  if (!treeState || treeState.loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500 py-3">
        <Loader2 size={14} className="animate-spin" />
        Loading bill of materials…
      </div>
    )
  }
  if (treeState.error) {
    return (
      <div className="text-xs text-red-400 py-3">
        Could not load the bill of materials. Try reselecting the product.
      </div>
    )
  }

  const roots = buildBomTree(treeState.nodes || [])
  if (roots.length === 0) {
    return <div className="text-xs text-gray-500 py-3">No bill of materials for this product.</div>
  }

  const qtyFor = (node) => (node.unitQty || 0) * (topQty || 0)
  const toggleCollapse = (key) => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))

  const renderNode = (node) => {
    const isGroup = node.partType === 'assembly' || node.partType === 'finished_good'
    const isPurchased = node.partType === 'purchased'
    const isOpen = !collapsed[node.key]

    if (node.isCycle) {
      return (
        <div key={node.key}
             className="flex items-center gap-2 px-3 py-2 rounded text-sm bg-red-950/40 border border-red-800/60">
          <AlertTriangle size={14} className="text-red-400" />
          <span className="text-red-300 font-mono">{node.partNumber}</span>
          <span className="text-red-400/80 text-xs">circular BOM reference — not expanded</span>
        </div>
      )
    }

    if (isGroup) {
      return (
        <div key={node.key} className="space-y-1">
          <button type="button" onClick={() => toggleCollapse(node.key)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded text-sm bg-purple-950/30 border border-purple-800/50 hover:bg-purple-900/30">
            <div className="flex items-center gap-2 min-w-0">
              {isOpen ? <ChevronDown size={14} className="text-purple-300 flex-shrink-0" /> : <ChevronRight size={14} className="text-purple-300 flex-shrink-0" />}
              <Layers size={14} className="text-purple-300 flex-shrink-0" />
              <span className="text-purple-200 font-mono truncate">{node.partNumber}</span>
              <span className="text-gray-500 truncate">- {node.description}</span>
              <span className="text-[10px] px-1.5 py-0.5 bg-purple-900/50 text-purple-300 rounded border border-purple-700/50 flex-shrink-0">Sub-Assembly</span>
            </div>
            <span className="text-gray-500 text-xs flex-shrink-0 ml-2">×{node.bomQuantity} · {qtyFor(node)} pcs</span>
          </button>
          {isOpen && node.children.length > 0 && (
            <div className="space-y-1" style={{ marginLeft: 16 }}>
              {node.children.map(child => renderNode(child))}
            </div>
          )}
        </div>
      )
    }

    if (isPurchased) {
      return (
        <div key={node.key}
             className="flex items-center justify-between px-3 py-2 rounded text-sm bg-gray-800 border border-gray-700 opacity-60">
          <div className="flex items-center gap-2 min-w-0">
            <ShoppingCart size={14} className="text-orange-400 flex-shrink-0" />
            <span className="text-gray-400 font-mono truncate">{node.partNumber}</span>
            <span className="text-gray-600 truncate">- {node.description}</span>
          </div>
          <span className="text-xs px-2 py-0.5 bg-orange-900/40 text-orange-400 rounded border border-orange-800/50 flex-shrink-0 ml-2">📦 Purchased</span>
        </div>
      )
    }

    const isSel = !!selected[node.key]
    return (
      <button key={node.key} type="button" onClick={() => onToggleLeaf(node)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded text-sm transition-colors ${
                isSel ? 'bg-green-900/30 text-green-300 border border-green-700'
                      : 'bg-gray-700 hover:bg-gray-600 text-gray-300'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <Wrench size={14} className="text-gray-500 flex-shrink-0" />
          <span className="font-mono truncate">{node.partNumber}</span>
          <span className="text-gray-500 truncate">- {node.description}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          <span className="text-gray-500 text-xs">×{node.bomQuantity} · {qtyFor(node)} pcs</span>
          {isSel ? <span className="text-green-400">✓ Job added</span> : <ChevronRight size={16} className="text-gray-500" />}
        </div>
      </button>
    )
  }

  const selectedCount = Object.values(selected || {}).filter(Boolean).length

  return (
    <div className="space-y-1 mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">Bill of Materials — select parts to manufacture</span>
        <span className="text-green-400 text-xs font-medium">{selectedCount} job(s) selected</span>
      </div>
      {roots.map(node => renderNode(node))}
    </div>
  )
}
