BEFORE STARTING: Read Docs/Decisions.md and Docs/S4_GoLive_Implementation_Plan.md in full.

Task: When an external routing step is marked complete, the WO Lookup routing list shows the step's `lot_number` field next to a checkmark. With per-batch outsourcing, multiple batches go to multiple vendor lots — showing one is misleading. Replace with just a checkmark for external steps. Per-batch vendor lots already appear in the OUTSOURCING section below the routing list.

Scope: src/pages/Mainframe.jsx ONLY. Two occurrences (around lines 2342 and 2606).

---

## Edit 1 — First occurrence (~line 2342)

Find:

```jsx
{step.status === 'complete' && (
  <span className="flex items-center gap-1 text-green-400"><CheckCircle size={10} />{step.lot_number || ''}</span>
)}
```

Replace with:

```jsx
{step.status === 'complete' && (
  <span className="flex items-center gap-1 text-green-400">
    <CheckCircle size={10} />
    {step.step_type !== 'external' && (step.lot_number || '')}
  </span>
)}
```

---

## Edit 2 — Second occurrence (~line 2606)

There's a duplicate routing-step render block further down. Apply the identical fix.

---

## Edit 3 — Verification

1. File compiles.
2. J-000051 WO Lookup: Heat Treatment row shows External pill + green checkmark only — no "47523" text next to it.
3. Internal complete steps (Machine Process, Passivation) still show their lot numbers next to the checkmark — no regression.
4. The OUTSOURCING section below still lists each batch's vendor lot — that's where per-batch lot info lives.

Do NOT touch other files.