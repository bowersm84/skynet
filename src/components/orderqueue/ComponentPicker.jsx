import { useEffect, useMemo, useState } from 'react'
import { Loader2, Wrench, ShoppingCart, Layers, AlertTriangle, Package } from 'lucide-react'
import { loadBom, buildBomTree, isJobLeafNode, isGroupNode } from '../../lib/nestedAssembly'
import { getInventoryFor, summarizeFbInventory } from '../../lib/fishbowl'

// ComponentPicker — D-FB-42. The structured replacement for the free-text "Components Needed".
//
// mode 'manufacture' (Create CO, Edit CO): the choices are the job leaves of the part's bill of
//   materials — manufactured parts and childless finished goods, exactly the nodes Create WO turns
//   into jobs (D-NEST-13, isJobLeafNode). Purchased leaves are shown muted for context; sub-assemblies
//   group their children. Nothing is pre-checked; the caller requires at least one. A part with no
//   BOM (a machined part sold on its own, e.g. SK-OS) offers itself, pre-selected and locked: there
//   is nothing else production could make for it.
// mode 'purchase' (Purchase disposition on a BOM part): every BOM node is a choice — a sub-assembly
//   can be bought complete. A part with no BOM renders nothing and reports hasBom=false through
//   onLoaded so the caller can pass it through untouched.
//
// `selected` is a Set of part uuids; `onChange(nextSet)` replaces it. `onLoaded({ hasBom, leafKeys })`
// fires once the BOM is in. Fishbowl availability (D-FB-33/39) is read per component so the OP can
// see stock before deciding.

// Only parts Fishbowl knows get a figure (D-FB-41: no row = not a Fishbowl part). `need` is how
// many of this component the lines being converted call for (unit qty × pieces), so the D-FB-39
// tone reads green when stock covers it and amber when it does not — the same rule as the Avail
// column and Create WO.
function AvailText({ inv, need }) {
  if (!inv) return null
  const s = summarizeFbInventory(inv, { need: need || 0 })
  return (
    <span className={`text-[11px] font-mono ${s.tone}`} title={`${s.title}${need ? `\n\nNeeded here: ${Number(need).toLocaleString()}`: ''}`}>
      {s.free.toLocaleString()} avail{need ? ` / ${Number(need).toLocaleString()}` : ''}
    </span>
  )
}

// needQty: pieces of the top part these lines call for; each component's need = unitQty × needQty.
export default function ComponentPicker({ partId, partNumber, partType, mode = 'manufacture', selected, onChange, onLoaded, needQty = 0 }) {
  const [tree, setTree] = useState({ loading: true, roots: [], error: null })
  const [inventory, setInventory] = useState({})
  const [collapsed, setCollapsed] = useState({})

  useEffect(() => {
    let cancelled = false
    setTree({ loading: true, roots: [], error: null })
    ;(async () => {
      const { nodes, error } = await loadBom(partId)
      if (cancelled) return
      const roots = error ? [] : buildBomTree(nodes || [])
      setTree({ loading: false, roots, error })
      const hasBom = roots.length > 0
      if (!hasBom && mode === 'manufacture' && !(selected && selected.size > 0)) {
        onChange?.(new Set([partId]))
      }
      onLoaded?.({ hasBom })
      const partNums = []
      const walk = (list) => { for (const n of list) { partNums.push(n.partNumber); walk(n.children) } }
      walk(roots)
      if (partNums.length > 0) {
        try {
          const inv = await getInventoryFor(partNums.map((p) => String(p).toUpperCase()))
          if (!cancelled) {
            const upper = {}
            for (const [k, v] of Object.entries(inv)) upper[k.toUpperCase()] = v
            setInventory(upper)
          }
        } catch (e) {
          console.warn('component inventory read failed:', e?.message || e)
        }
      }
    })()
    return () => { cancelled = true }
    // selected is intentionally not a dependency: the self-select only runs on load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [partId, mode])

  const selectedSet = selected || new Set()
  const toggle = (id) => {
    const next = new Set(selectedSet)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange?.(next)
  }

  const choosable = useMemo(() => {
    const keys = []
    const walk = (list) => {
      for (const n of list) {
        if (n.isCycle) continue
        if (mode === 'purchase' || isJobLeafNode(n)) keys.push(n.componentId)
        walk(n.children)
      }
    }
    walk(tree.roots)
    return keys
  }, [tree.roots, mode])

  if (tree.loading) {
    return <div className="flex items-center gap-2 text-xs text-gray-500 py-2"><Loader2 size={12} className="animate-spin" /> Loading bill of materials…</div>
  }
  if (tree.error) {
    return <div className="text-xs text-red-400 py-2">Could not load the bill of materials for {partNumber}.</div>
  }

  // No BOM
  if (tree.roots.length === 0) {
    if (mode === 'purchase') {
      return <div className="text-xs text-gray-500 py-2">{partNumber} has no bill of materials — purchased as-is.</div>
    }
    return (
      <label className="flex items-center gap-2 px-3 py-2 rounded text-sm bg-green-900/20 border border-green-800/60 cursor-default">
        <input type="checkbox" checked readOnly className="accent-green-500" />
        <Wrench size={14} className="text-green-400 flex-shrink-0" />
        <span className="font-mono text-green-200">{partNumber}</span>
        <span className="text-gray-500 text-xs">{partType === 'purchased' ? 'purchased part' : 'machined part — this is what production makes'}</span>
      </label>
    )
  }

  const inventoryFor = (node) => inventory[String(node.partNumber || '').toUpperCase()]

  const renderNode = (node) => {
    const isGroup = isGroupNode(node)
    const isPurchased = node.partType === 'purchased'
    const canPick = !node.isCycle && (mode === 'purchase' || isJobLeafNode(node))
    const isSel = selectedSet.has(node.componentId)
    const isOpen = !collapsed[node.key]

    if (node.isCycle) {
      return (
        <div key={node.key} className="flex items-center gap-2 px-3 py-1.5 rounded text-xs bg-red-950/40 border border-red-800/60">
          <AlertTriangle size={12} className="text-red-400" />
          <span className="text-red-300 font-mono">{node.partNumber}</span>
          <span className="text-red-400/80">circular BOM reference — not expanded</span>
        </div>
      )
    }

    const row = (
      <div
        key={node.key}
        className={`flex items-center justify-between gap-2 px-3 py-1.5 rounded text-sm border ${
          canPick && isSel ? 'bg-green-900/30 border-green-700'
            : canPick ? 'bg-gray-800 border-gray-700 hover:bg-gray-700/80'
              : isGroup ? 'bg-purple-950/30 border-purple-800/50'
                : 'bg-gray-800/60 border-gray-800 opacity-60'
        }`}
      >
        <label className={`flex items-center gap-2 min-w-0 ${canPick ? 'cursor-pointer' : 'cursor-default'}`}>
          {canPick ? (
            <input type="checkbox" checked={isSel} onChange={() => toggle(node.componentId)} className="accent-green-500" />
          ) : (
            <span className="w-[13px]" />
          )}
          {isGroup ? <Layers size={13} className="text-purple-300 flex-shrink-0" />
            : isPurchased ? <ShoppingCart size={13} className="text-orange-400 flex-shrink-0" />
              : <Wrench size={13} className="text-gray-400 flex-shrink-0" />}
          <span className={`font-mono truncate ${canPick && isSel ? 'text-green-200' : 'text-gray-200'}`}>{node.partNumber}</span>
          <span className="text-gray-500 text-xs truncate">{node.description}</span>
          {isGroup && <span className="text-[10px] px-1.5 py-0.5 bg-purple-900/50 text-purple-300 rounded border border-purple-700/50 flex-shrink-0">Sub-assembly</span>}
          {isPurchased && <span className="text-[10px] px-1.5 py-0.5 bg-orange-900/40 text-orange-400 rounded border border-orange-800/50 flex-shrink-0">Purchased</span>}
        </label>
        <span className="flex items-center gap-3 flex-shrink-0 text-xs text-gray-500">
          <AvailText inv={inventoryFor(node)} need={(node.unitQty || 0) * (needQty || 0)} />
          <span>×{node.bomQuantity}</span>
          {isGroup && node.children.length > 0 && (
            <button type="button" onClick={() => setCollapsed((p) => ({ ...p, [node.key]: !p[node.key] }))} className="text-purple-300 hover:text-white">
              {isOpen ? 'hide' : `${node.children.length} inside`}
            </button>
          )}
        </span>
      </div>
    )

    if (isGroup && node.children.length > 0 && isOpen) {
      return (
        <div key={node.key} className="space-y-1">
          {row}
          <div className="space-y-1" style={{ marginLeft: 16 }}>{node.children.map(renderNode)}</div>
        </div>
      )
    }
    return row
  }

  const selectedCount = choosable.filter((id) => selectedSet.has(id)).length
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-500 flex items-center gap-1">
          <Package size={12} /> {mode === 'purchase' ? 'Which component(s) are being purchased?' : 'Which component(s) does production need to make?'}
        </span>
        <span className="flex items-center gap-3">
          <span className={selectedCount > 0 ? 'text-green-400' : 'text-amber-300'}>{selectedCount} selected</span>
          <button type="button" className="text-gray-400 hover:text-white" onClick={() => onChange?.(new Set(choosable))}>all</button>
          <button type="button" className="text-gray-400 hover:text-white" onClick={() => onChange?.(new Set())}>none</button>
        </span>
      </div>
      {tree.roots.map(renderNode)}
    </div>
  )
}
