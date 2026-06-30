# Blanks Inventory — Implementation Plan

**Goal:** Track uncut cold-headed stud blanks (run only in Bolt Master machines, 1 blank = 1 part) as a first-class inventory category alongside bar stock, so bolt-master consumption deducts from a real lot instead of generating Unknown-Lot reconciliation flags with placeholder numbers.

**Approach:** Blanks reuse the existing material tables (`material_receiving`, `material_usage`, `material_availability`) with a `category` flag (`'bar'` default, `'blank'`). This inherits availability, reconciliation, and the cycle-count screen for free. Only two things differ from bars: a slimmer Receive Blanks form, and a different consumption hook (deduct at completion by the finishing count, since bolt-master machines already run through the machine kiosk).

---

## Locked decisions (from scoping with Matt)

- **What a blank is:** uncut cold-headed stud, no cross hole / face markings; machined to spec in Bolt Master machines only; one blank → one part (1:1).
- **Data model:** a `'blank'` row in `material_receiving` has `bar_length_inches = null`, `material_type` = blank type, `bar_size` = dash, `quantity` = blank count, `price_per_bar` = cost per blank, `material_id = null` (no materials-master row).
- **Receive Blanks fields:** Vendor · Blank type (4000 / 2000) · Dash (1–20) · Total quantity · Total cost · Cost per blank (calculated = total ÷ qty) · Rack (default "Blank Rack").
- **Cost:** enter **total** cost (e.g. $1,100); cost per blank is calculated.
- **Blank type:** fixed two options — 4000, 2000. **Dash:** list 1–20.
- **Consumption:** deduct by the **finishing count**, not the machinist count (machinist count not trusted). Hook is the finishing-derived good total at job completion.
- **Bolt-master flow:** these jobs already run on the machine kiosk — lot entry + deduction go there. **Nothing is added to the raw-material kiosk.**
- **Inventory page:** split Bars vs Blanks; blanks have fewer columns and far fewer rows.
- **Blank Rack:** racks aren't a managed list (just a value typed at receiving), so blanks default the rack to "Blank Rack".

---

## Phase 1 — Receiving + visibility (no consumption yet). Shippable on its own.

1. **DB:** add `category text not null default 'bar'` (check in `('bar','blank')`) to `material_receiving`, plus an index. Existing rows default to `'bar'`.
2. **loadInventory:** after the `material_availability` fetch, side-lookup `category` per `material_receiving_id` from `material_receiving` and attach `r.category`. (No view change needed.)
3. **Receive Blanks form:** a Bar / Blank toggle on the Receiving tab. Blank mode shows the six fields, computes cost-per-blank live, and inserts a `material_receiving` row with `category='blank'`, `material_id=null`, `bar_length_inches=null`, `price_per_bar = total ÷ qty`, `rack` defaulting to "Blank Rack". Blank type is a 4000/2000 select; dash is a 1–20 select.
4. **Inventory page:** a Bars / Blanks switch. Blanks table columns: Rack · Vendor · Type · Dash · Qty Available · Cost/Blank. The existing Bars views (Lot / By Size) filter to `category='bar'`.

**Phase 1 build order (two CC prompts):** (1a) migration + Receive Blanks form; (1b) inventory Bars/Blanks split.

---

## Phase 2 — Consumption (bolt-master kiosk). Later.

- **At job start (machine kiosk, Bolt Master only):** machinist enters the blank lot (validated against on-hand blank inventory) instead of loading bars; store the lot on the job. Determine "blank job" by the assigned machine being a Bolt Master.
- **At completion:** create a `material_usage` row for that blank lot with `quantity_used = finishing good count` (not the machinist count), deducting from blank inventory.
- This is what makes the bolt-master Unknown-Lot flags stop.

**Known, accepted simplification:** deducting the finishing (good) count means scrapped blanks aren't deducted, so blank on-hand can drift slightly high over time. The periodic blank cycle count (inherited from the cycle-count screen) corrects this drift — that's the safety net.

---

## Phase 3 — Cleanup / reconciliation. Later.

- Verify reconciliation and cycle count behave for blanks (mostly inherited via `category`); the cycle-count screen already handles them once they're real lots.
- Decide what to do with the historical placeholder flags (5-digit lots like 51254 / 50990 / 51118) and stop the placeholder generation now that real blank lots exist.

---

## Phase 1, step 1 — migration (TEST → PROD)

```sql
-- Blanks Phase 1 — category flag on material_receiving. TEST (ylzmyjjqibpbqbwjsnqj), then PROD (luzungoqfuplspzbqctb).
alter table public.material_receiving
  add column if not exists category text not null default 'bar';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'material_receiving_category_check'
  ) then
    alter table public.material_receiving
      add constraint material_receiving_category_check check (category in ('bar','blank'));
  end if;
end $$;

create index if not exists idx_material_receiving_category
  on public.material_receiving(category);
```
