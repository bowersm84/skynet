# SkyNet — Multi-Role Support + Purchaser Role — Implementation Plan

**Status:** Ready to build · **Target spec:** v3.8 arc · **Approach:** foundational-but-scoped

This plan covers two coupled changes. Build them in one effort, migration first.

---

## Prerequisites for the executing chat
Upload to the build chat before starting:
- Current `src.zip` (post Finished-Goods/Material-Catalog rename round).
- Current `Supabase_SQL_Database.txt` (schema).
- The inventory migration files from `Docs/migrations/` that contain the current bodies of `submit_inventory_adjustments`, `link_unknown_lot_usage`, `review_inventory_adjustment`, and `review_inventory_adjustment_session` (needed to `CREATE OR REPLACE` them with the role-check change). If not in the repo, pull current definitions from the DB.

Conventions: one CC prompt per round as a single copyable block with exact Find/Replace anchors; SQL in separate copyable blocks; CRLF line endings; TEST before PROD; read `Docs/Decisions.md` first.

---

## Goal

**1. Multi-role.** Let a user hold more than one role (Sawyer = `customer_service` + `purchaser`). Keep `profiles.role` as the **primary** role; add `profiles.roles text[]` for **additional** roles. Effective role set = primary ∪ additional. Single-role users (everyone today) are unaffected — their `roles` is empty and effective = `{role}`.

**2. Purchaser role.** New role: views Finished Goods + Raw Materials, **writes** inventory adjustments (submit only), replenishment rules, and reconciliation (resolve + link); read-only everywhere else.

### Decisions locked
- Schema: `roles text[]` on `profiles` (not a join table).
- `profiles.role` stays as the primary; `roles` holds the extras.
- Scope: **foundational-but-scoped** — build the infra and apply it in Armory, the inventory RPCs, and the sales-dashboard/route guards (everything Sawyer touches). Peripheral role checks elsewhere keep reading the primary `role` for now and migrate opportunistically.
- Purchaser: Receiving **view-only**; adjustments **submit only** (no approve); reconciliation **resolve + link**.

### Confirmed purchaser permission matrix

| Section | Tab | Purchaser |
|---|---|---|
| Finished Goods | Products, Parts, Routing Templates | View-only |
| Raw Materials | Material Types, Bar Sizes, Material Catalog | View-only (master data) |
| Raw Materials | Inventory | View |
| Raw Materials | Adjustments | **Write — submit** cycle counts (no approve) |
| Raw Materials | Reconciliation | **Write** — resolve + link flags |
| Raw Materials | Replenishment Rules | **Write** — create/edit |
| Raw Materials | Receiving | View-only |
| — | Customers, Users | No access |

(Sawyer also retains all Customer Service access via her primary role — the tab set is a **union** across her roles.)

---

## Part A — Database migration (TEST first, then PROD)

```sql
-- Migration: 2026-06-17_multi_role_purchaser.sql
BEGIN;

-- 1. Additional roles. Primary stays profiles.role; effective = role ∪ roles.
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS roles text[] NOT NULL DEFAULT '{}';
-- No backfill needed: effective role set always includes the primary `role`.

-- 2. Role-membership helper. True if the user's primary role OR any additional
--    role is in p_roles. Used by RPCs (and available to RLS if needed later).
CREATE OR REPLACE FUNCTION user_has_role(p_uid uuid, VARIADIC p_roles text[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = p_uid
      AND (role = ANY(p_roles) OR roles && p_roles)
  );
$$;

COMMIT;
```

### A.3 — Inventory RPC role-check updates (separate block; `CREATE OR REPLACE` each from its current body)
Reproduce each function's **current** body verbatim from the migration files, changing **only** the role gate:

- **`submit_inventory_adjustments`** — replace the gate
  `IF v_role NOT IN ('admin','compliance','machinist','finishing') THEN RAISE EXCEPTION 'Not authorized to submit cycle counts'; END IF;`
  with
  `IF NOT user_has_role(auth.uid(), 'admin','compliance','machinist','finishing','purchaser') THEN RAISE EXCEPTION 'Not authorized to submit cycle counts'; END IF;`
  (The `SELECT role INTO v_role` line can be removed if `v_role` is no longer referenced.)

- **`link_unknown_lot_usage`** — replace the gate
  `IF v_role NOT IN ('admin','compliance') THEN ...`
  with
  `IF NOT user_has_role(auth.uid(), 'admin','compliance','purchaser') THEN ...`

- **`review_inventory_adjustment`** — keep approvers admin/compliance, but make both checks multi-role aware:
  - gate → `IF NOT user_has_role(auth.uid(),'admin','compliance') THEN RAISE EXCEPTION 'Not authorized to review adjustments'; END IF;`
  - self-approve exemption → `IF v_req = v_caller AND NOT user_has_role(auth.uid(),'admin') THEN RAISE EXCEPTION 'You cannot approve your own adjustment'; END IF;`

- **`review_inventory_adjustment_session`** — same:
  - gate → `IF NOT user_has_role(auth.uid(),'admin','compliance') THEN ...`
  - self-approve exemption → `IF NOT user_has_role(auth.uid(),'admin') AND EXISTS ( SELECT 1 FROM inventory_adjustment_requests WHERE count_session_id = p_count_session_id AND status = 'pending' AND requested_by = v_caller ) THEN ...`

> **RLS:** no policy changes. The inventory tables (`material_reconciliation_flags`, `material_replenishment_rules`, `inventory_adjustment_requests`, `material_documents`) are already `FOR ALL TO authenticated`; gating is enforced in the UI + the RPCs above. The RLS guardrail CI is unaffected.

---

## Part B — Frontend (one CC prompt)

### B.1 — `src/lib/roles.js` (helpers)
Add:
```js
export function userRoles(profile) {
  return [...new Set([profile?.role, ...(profile?.roles || [])].filter(Boolean))]
}
export function hasRole(profile, ...roles) {
  return userRoles(profile).some(r => roles.includes(r))
}
// Master-data + finished-goods writes (Material Types/Catalog, Bar Sizes, Products, Parts, Routing).
export function canWriteMasterData(profile) {
  return hasRole(profile, 'admin', 'compliance')
}
// Receiving writes — keeps finishing's existing access; excludes purchaser.
export function canReceive(profile) {
  return hasRole(profile, 'admin', 'compliance', 'finishing')
}
```
Update `canViewSalesDashboard` to be multi-role aware:
```js
export function canViewSalesDashboard(profile) {
  if (!profile) return false
  return hasRole(profile, 'admin', 'customer_service', 'president', 'viewer') || profile.is_salesperson === true
}
```
(If `canSeeBridge` is used with a profile anywhere, add a `hasRole(profile,'president','admin')` variant.)

### B.2 — `src/pages/Armory.jsx`
- Import `userRoles, hasRole, canWriteMasterData, canReceive` from `../lib/roles`.
- **Add purchaser to `TAB_ACCESS_BY_ROLE`:**
  ```
  purchaser: ['assemblies','components','routing','materials','barsizes','material_master','inventory','adjustments','reconciliation','receiving','replenishment'],
  ```
- **Tab visibility → union.** Replace
  `const visibleTabIds = TAB_ACCESS_BY_ROLE[profile?.role] || []`
  with
  `const visibleTabIds = [...new Set(userRoles(profile).flatMap(r => TAB_ACCESS_BY_ROLE[r] || []))]`
- **Master-data/finished-goods write gate.** Replace
  `const canWrite = !isReadOnlyRole(profile?.role)`
  with
  `const canWrite = canWriteMasterData(profile)`
  (Safe — verified no regression: the only roles that see these tabs are admin/compliance [write] and president/viewer [read]; purchaser is new and read-only. `canWrite` is used at the Products/Parts/Material Types/Material Catalog/Bar Sizes/Routing write buttons.)
- **Receiving write gate (NEW).** The Receiving "Log Receipt" button and the receiving write actions (edit/delete, rack assign in the receiving table, cert upload) are currently gated only by tab visibility. Wrap them in `canReceive(profile)` so purchaser is view-only while admin/compliance/finishing keep write. (Find the `Log Receipt` button and the receiving-row action controls.)
- **Replenishment write:** `canEditRules` → `hasRole(profile,'admin','compliance','purchaser')`.
- **Adjustments review (approver):** `isApprover` → `hasRole(profile,'admin','compliance')` (purchaser is **not** an approver; they only see the Cycle Count sub-tab, which submits via the RPC).
- **Reconciliation link:** `canLink` → `hasRole(profile,'admin','compliance','purchaser')`.
- **Admin self-approve gating** (the `isOwn` line in the Adjustments review): `profile?.role !== 'admin'` → `!hasRole(profile,'admin')`.
- Sweep any other `profile?.role`-based capability checks in this file and route through `hasRole`.

### B.3 — `src/pages/UsersTab.jsx`
- Add **`purchaser`** to the role options list (wherever roles are enumerated for the dropdown).
- Keep the existing **primary role** dropdown (writes `profiles.role`).
- Add an **"Additional Roles"** multi-select (checkbox list) that writes `profiles.roles` (array of role keys, excluding the primary). On save, include `roles` in the insert/update payload.
- In the user list, ensure the fetch selects `roles` and display them (primary + chips for additional).

### B.4 — `src/App.jsx`
- **Profile fetch (~line 151):** ensure `roles` is included (if `select('*')`, already covered; if a column list, add `roles`). The `profile` object passed through the app must carry `roles`.
- **Armory route guard:** ensure `purchaser` can reach `/armory` (admit purchaser, or gate on "has any accessible Armory tab").
- **Sales dashboard guard:** uses `canViewSalesDashboard(profile)` (now multi-role) — Sawyer (cs) passes; no change needed beyond B.1.
- **Other route guards:** leave reading the primary `role` for now (scoped). Multi-role users are evaluated on their primary role for those non-migrated routes — fine for Sawyer (primary = customer_service; purchaser is Armory-only, which uses the union).

---

## Sequencing
1. Apply **Part A** migration on TEST.
2. Run the **Part B** CC prompt on TEST.
3. Verify (below) on TEST.
4. Apply Part A + Part B on PROD; merge to `main` (Amplify deploys).
5. **Assign Sawyer:** via the new Users UI (or one-off SQL) set `role = 'customer_service'` (primary, unchanged) and `roles = ARRAY['purchaser']`.

## Verification
1. `npm run build` passes.
2. **Purchaser-only test user** (`role='purchaser'`, `roles='{}'`):
   - Sees Finished Goods (Products/Parts/Routing) **view-only** and Raw Materials.
   - Master data (Material Types/Catalog, Bar Sizes) view-only; **Receiving view-only** (no Log Receipt); no Customers/Users.
   - Can **submit** a cycle count; **cannot** see the Review sub-tab / approve.
   - Can **create/edit replenishment rules**; can **resolve and link** reconciliation flags.
3. **Sawyer (`role='customer_service'`, `roles='{purchaser}'`):** sees Customers **and** all purchaser tabs (union); Sales Dashboard still accessible; existing CS behavior intact.
4. **Single-role users unchanged** (e.g., finishing still logs receipts; admin/compliance still write master data and approve adjustments; president/viewer still read-only).
5. **RPCs:** purchaser can submit adjustments and link unknown lots; cannot approve. Admin self-approve still works (including an admin who also holds another role).

## Gotchas / notes
- **Don't break finishing's Receiving write.** This is why Receiving gets its own `canReceive` (admin/compliance/finishing) gate, separate from `canWriteMasterData` (admin/compliance).
- **Kiosks unaffected.** They authenticate operators by PIN via `kiosk-authenticate`, not `profiles.role`; no multi-role work there.
- **RLS unaffected.** Inventory-table writes are authenticated-all; gating lives in the UI + RPCs. RLS guardrail CI should still pass.
- **Peripheral guards** (Finishing, Compliance, President's Bridge, Customer Orders, Mainframe) keep reading the primary `role`. Acceptable for this scoped rollout; migrate to `hasRole` opportunistically as those areas are touched.
- After merge, this closes the inventory arc → bump spec to **v3.8** and add Decisions.md entries (incl. D-MULTIROLE for the role model and D-PURCHASER for the matrix).
