# Skybolt Scheduling — Context for a New Chat (as of 2026-10-28)

Upload this file at the start of a new chat in the SkyNet project and say what this round covers (exclusions, anything urgent). Everything marked "as of" is a snapshot — read the live board before relying on it.

---

## 1. The job

Claude plays the Skybolt scheduler. Each round:

1. Matt says what to ignore and anything special (e.g. "ignore J-000263, the Giza SK-OS demand, Kaytech").
2. Claude reads the live board from **PROD (read-only)**: machines and their state, what is running and queued, the Job Pool (unassigned jobs), and Demand (open CO lines not yet covered by a WO).
3. Claude proposes a schedule. **Matt makes every change in Prod himself.** Nothing is written to PROD by Claude.
4. Expect back-and-forth: Matt corrects machine knowledge, Claude revises.

**What a good proposal looks like**

- A short board summary first (idle machines, down machines, anything with a near target).
- One table per machine that gets work: sequence, job (or NEW / POOL), part × qty **and material**, customer · tier · target, est. finish. Part numbers first, always.
- "WOs to create from Demand" (part, CO lines, component to cut, qty, Fishbowl on-hand, target).
- Holds / questions (things that need Matt's call before machine time is committed — e.g. Fishbowl already has the stock).
- Watch items (down machines with critical work, machines about to run dry).
- On request: a printable worksheet (a Claude Doc, exported to PDF; Ctrl+P on the doc also prints).

---

## 2. Matt's standing scheduling rules

1. **Tiered customers come first.** Make target dates, but "don't get crazy." Tier lives in `v_customer_pricing_current.tier`: `none`, `tier1`, `tier2`, `tier3`, `premier` (plus column tiers `q100/q300/q500`). Any tier beats `none`.
2. **Put similar parts where they are already running** (cups with cups, studs with studs) — a guideline, not a hard rule.
3. **Keep like materials together** (stainless with stainless, steel with steel) and avoid back-to-back swaps: a swap means cleaning the machine and changing chip buckets. Show the material on every row so the grouping is visible.
4. **Bolt Masters only make Phillips studs from stocked blanks:** 4000-series Phillips on **BM 1, 3, 5**; 2000-series Phillips on **BM 2, 4, 6**.
5. **Any stud longer than -15 runs on Bolt Master 1** — the long blanks are unmarked and only BM-1 cuts and stamps them to length.
6. **Cups typically run on a Nexturn.**
7. **SKFJ4-30SS** (#4 flush stud, stainless) runs on **Mazak 1 or 2**.
8. **Don't reorder work that is in setup or already late** to make room (e.g. the T26 tool parts on Mazak 5 stayed put).
9. **Check Fishbowl stock before cutting.** If `fb_part_inventory.qty_available` covers the need, propose filling from stock instead of machine time.
10. **Where a traveler and SkyNet disagree on a machine, SkyNet is the record** (travelers were printed ahead and could fall out of sync).
11. **New Nexturn NT-8** (Oct 27) — schedulable; Matt wants the Bolt Masters listed behind the Nexturns in the lineup.
12. **Stock runs** (when machines are short on work): favor studs bought by several customers at volume; size at roughly 4–6 months of demand *excluding the single biggest customer*, in the usual lot sizes (2,500 / 5,000 for Phillips studs); check blank inventory first.

Open question from Oct 15 (not yet answered): the advisor's standing rules say SK27CP# over -16 runs on a Nexturn and Bolt Masters run -16 and below in the 26/27 series — does rule 5 (over -15 → BM-1) apply to the 4000 series only, or supersede that?

**Recurring exclusions used in October rounds** (confirm each round): J-000263 (SK2003-10C1 flange), RQ-91167928 (SK26R9S, ALIGN), J-000243 (SK-RVC), the Giza SK-OS demand lines, Kaytech orders. *Kaytech note:* the account was squared Oct 27 and Matt is ready to resume their orders (handled in a dedicated Kaytech chat; 30% deposit before starting QL4-21) — ask whether Kaytech is in scope.

---

## 3. Machines and what runs where

Floor (check live status every round): **Mazak 1–7** (Mazak 7 inactive; Mazak 6 down awaiting bar feed and live tooling), **Ganesh 1**, **Bolt Master 1–6**, **Nexturn 1–8** (Nexturn 1 is at Tavares; NT-8 new Oct 27). Finishing tanks and ovens are not machining slots.

Machine knowledge gathered so far:

- Bolt Masters: Phillips studs from blanks only (rule 4); BM-1 for over -15 (rule 5). Lights-out rates ~14–17 pcs/hr, so 5,000 pcs ≈ 2 weeks.
- Nexturns: cups (SK4C#C, SK26CR, SK4C#), slotted / folding-wing studs; SK-OS and SK-NS grommets.
- Mazak 5: wing studs (SK4C#W1, SK26C#W1, SK4-#W1) and the SK-T26 tool parts.
- Mazak 1/2/3/4: inserts, barrels, flanges, wing studs, flush studs; slotted studs (SK4C#S) ran on Mazaks before moving to Nexturns.
- Ganesh 1: flanges (SK2003-10C1 — 13 traveler runs), SK212-12A8.
- QL8-CS (A286): ran on Mazak 7 at roughly 3 pcs/hr; A286 runs lights-out but tool life is about half.
- As of Oct 20: Nexturn 1 down (sub-collet sensor), Nexturn 2 down, Ganesh 1 down, Mazak 6 down.

---

## 4. Run history — where a part has actually run

- **SkyNet runs** (April 2026 on): `part_machine_stats`, `v_part_run_rates` (`source = 'skynet'`).
- **Traveler archive** (October 2021 – May 2026, D-HIST-01): `historical_runs` (2,233 runs; 2,084 counted, ~6.5M pieces). Summary by part × machine: `v_historical_part_machine`. Since D-HIST-02 (views live on PROD Oct 28; app changes awaiting ship) the archive also appears in `v_part_run_rates` (`source = 'archive'`), `v_length_family_machine_history.archive_runs`, and the first-run flag.
- Caveats: the archive machine is the one *written on the traveler*; "Mazak ?" means the number was not written; archive runs carry **no rate** (no hours on a traveler); rows also in SkyNet (`skynet_job_id`) defer to SkyNet; rows with no quantity are `excluded`.
- Length families (`parts.length_family_key`, e.g. SK4C#S) — `v_length_family_machine_history` shows what the rest of a family has done on each machine.
- Standing rules for Uncle Bob live in `scheduler_policies` (`is_active`).

---

## 5. Queries that work on PROD (`luzungoqfuplspzbqctb`, read-only)

Schema gotchas found the hard way: downtime uses `machine_downtime_logs.end_time` (null = open); `customer_order_line_components` has `component_id` only (no qty); BOMs are `assembly_bom(assembly_id, component_id, quantity, sort_order)`; `material_receiving.received_at`; there is no `fb_customer_master` table — match `customers.customer_id = fb_customer_id::text`; `fb_sales_orders.fb_date_created`; jobs' `production_lot_number` uses the traveler lot format (`2592-051126`).

**Machines**
```sql
select m.name, m.status, m.status_reason, m.machine_type,
  (select string_agg(d.reason || coalesce(' ('||d.notes||')',''), '; ')
     from machine_downtime_logs d where d.machine_id = m.id and d.end_time is null) as open_downtime
from machines m where coalesce(m.is_active, true)
order by m.display_order, m.name;
```

**What is on each machine**
```sql
select m.name as machine, j.job_number, j.status, p.part_number, mt.short_code as matl,
  j.quantity, j.good_pieces, j.estimated_minutes,
  to_char(j.scheduled_start at time zone 'America/New_York','MM-DD HH24:MI') as s,
  to_char(j.scheduled_end   at time zone 'America/New_York','MM-DD HH24:MI') as e,
  to_char(coalesce(j.production_start, j.setup_start) at time zone 'America/New_York','MM-DD') as started,
  w.customer, w.priority as prio, w.order_type, wd.target_date as target, wd.fb_due_date as fb_due
from jobs j
join machines m on m.id = j.assigned_machine_id
left join parts p on p.id = j.component_id
left join material_types mt on mt.id = p.material_type_id
left join work_orders w on w.id = j.work_order_id
left join v_wo_dates wd on wd.work_order_id = w.id
where j.status in ('assigned','ready','pending_compliance','in_setup','in_progress','pending_passivation','in_passivation')
  and m.machine_type in ('Mazak','Ganesh','Bolt Master','Nexturn')
order by m.display_order, m.name, j.scheduled_start nulls last;
```

**Job Pool, with SkyNet and traveler history**
```sql
select j.job_number, j.status, p.part_number, p.length_family_key, mt.short_code as matl,
  j.quantity, j.estimated_minutes, w.wo_number, w.customer, w.order_type, w.has_open_shortfall,
  wd.target_date, wd.fb_due_date, to_char(j.created_at at time zone 'America/New_York','MM-DD') as created,
  (select string_agg(s.machine_name || ' ' || round(coalesce(s.actual_pcs_per_hour,0))::text || '/hr', '; ')
     from part_machine_stats s where s.part_id = p.id) as skynet_history,
  (select string_agg(v.machine_name || ' ' || v.runs || 'x (last ' || v.last_run || ')', '; ' order by v.runs desc)
     from v_historical_part_machine v where v.part_id = p.id) as traveler_history,
  (select string_agg(f.machine_name || ' (' || f.runs || ' runs)', '; ' order by f.runs desc)
     from v_length_family_machine_history f where f.length_family_key = p.length_family_key) as family_history
from jobs j
left join parts p on p.id = j.component_id
left join material_types mt on mt.id = p.material_type_id
left join work_orders w on w.id = j.work_order_id
left join v_wo_dates wd on wd.work_order_id = w.id
where j.status in ('ready','pending_compliance') and j.assigned_machine_id is null
order by j.created_at;
```

**Demand — open CO lines not yet covered by a WO**
```sql
with alloc as (select customer_order_line_id, sum(quantity_allocated) as allocated
                 from customer_order_allocations where is_active group by 1)
select co.co_number, c.name as customer, l.line_number, p.part_number, p.part_type,
  l.quantity_ordered - l.quantity_fulfilled - coalesce(a.allocated,0) as remaining,
  d.target_date, d.fb_due_date, d.fb_due_is_default, l.priority,
  (select string_agg(cp.part_number, ', ') from customer_order_line_components clc
     join parts cp on cp.id = clc.component_id where clc.customer_order_line_id = l.id) as requested_components,
  (select string_agg(bp.part_number || ' x' || b.quantity || ' [' || coalesce(bmt.short_code,'') || ']', ', ' order by b.sort_order)
     from assembly_bom b join parts bp on bp.id = b.component_id
     left join material_types bmt on bmt.id = bp.material_type_id where b.assembly_id = p.id) as bom,
  (select tier from v_customer_pricing_current v where v.name = c.name limit 1) as tier
from customer_order_lines l
join customer_orders co on co.id = l.customer_order_id
left join customers c on c.id = co.customer_id
left join parts p on p.id = l.part_id
left join alloc a on a.customer_order_line_id = l.id
left join v_co_line_dates d on d.customer_order_line_id = l.id
where l.status in ('not_started','in_progress') and co.status <> 'cancelled'
  and l.quantity_ordered - l.quantity_fulfilled - coalesce(a.allocated,0) > 0
order by d.target_date nulls last, co.co_number, l.line_number;
```

**Fishbowl stock** (list the parts and components in question)
```sql
select part_num, qty_on_hand, qty_allocated, qty_available, qty_on_order,
       to_char(snapshot_at at time zone 'America/New_York','MM-DD HH24:MI') as snap
from fb_part_inventory where part_num in ('SK4C8','SK4C15')  /* replace */
order by part_num;
```

**Where a set of parts has run** (SkyNet + traveler archive)
```sql
select p.part_number,
  (select string_agg(s.machine_name || ' ' || s.completed_runs || ' runs', '; ') from part_machine_stats s where s.part_id = p.id) as skynet,
  (select string_agg(v.machine_name || ' ' || v.runs || 'x/' || v.pieces || 'pcs ' || v.first_run || '..' || v.last_run, '; ' order by v.runs desc)
     from v_historical_part_machine v where v.part_id = p.id) as travelers
from parts p where p.part_number in ('SKFJ4-30SS','SK4C8')  /* replace */
order by p.part_number;
```

**Stock-run candidates for the Bolt Masters** (12-month demand rolled down from assemblies through the BOM, demand excluding the top customer, cover in months, estimated blanks on hand)
```sql
with recursive studs as (
  select p.id, p.part_number, mt.short_code as blank,
    case when p.part_number ~ '^SK4C[0-9]+P$'   then 'Stainless|4000|' || substring(p.part_number from 'SK4C([0-9]+)P')
         when p.part_number ~ '^SK4-[0-9]+P$'   then 'Steel|4000|'     || substring(p.part_number from 'SK4-([0-9]+)P')
         when p.part_number ~ '^SK27CP[0-9]+$'  then 'Stainless|2700|' || substring(p.part_number from 'SK27CP([0-9]+)')
         when p.part_number ~ '^SK26CP[0-9]+$'  then 'Stainless|2600|' || substring(p.part_number from 'SK26CP([0-9]+)')
         when p.part_number ~ '^SK27-P[0-9]+$'  then 'Steel|2700|'     || substring(p.part_number from 'SK27-P([0-9]+)')
         when p.part_number ~ '^SK26-P[0-9]+$'  then 'Steel|2600|'     || substring(p.part_number from 'SK26-P([0-9]+)') end as bkey
  from parts p join material_types mt on mt.id = p.material_type_id where mt.short_code in ('BLK2000','BLK4000')
),
up as (
  select s.id as stud_id, s.id as product_id, 1::numeric as qty_per, 0 as depth from studs s
  union all
  select u.stud_id, b.assembly_id, u.qty_per * coalesce(b.quantity,1), u.depth + 1
  from up u join assembly_bom b on b.component_id = u.product_id where u.depth < 6
),
products as (select u.stud_id, u.product_id, p.part_number as product, max(u.qty_per) as qty_per
               from up u join parts p on p.id = u.product_id group by 1,2,3),
sales as (
  select pr.stud_id, h.fb_customer_id, sum(h.qty_ordered * pr.qty_per) as qty
  from products pr join fb_so_history_lines h on upper(h.part_num) = upper(pr.product)
  where h.line_type_id in (10,12) and h.fb_date_created >= now() - interval '12 months'
  group by pr.stud_id, h.fb_customer_id
),
agg as (select stud_id, sum(qty) as qty_12m, count(*) as cust_12m, max(qty) as top1_qty,
               count(*) filter (where qty >= 500) as cust_500plus from sales group by stud_id),
top1 as (select distinct on (stud_id) stud_id, fb_customer_id as top_cust from sales order by stud_id, qty desc),
inv as (
  select pr.stud_id,
    sum(case when pr.product_id = pr.stud_id then i.qty_available else 0 end) as stud_avail,
    sum(case when pr.product_id <> pr.stud_id then greatest(i.qty_available,0) * pr.qty_per else 0 end) as asm_avail
  from products pr left join fb_part_inventory i on upper(i.part_num) = upper(pr.product) group by pr.stud_id
),
pipe as (
  select j.component_id as stud_id,
    sum(coalesce(j.good_pieces,0)) filter (where j.status in ('pending_tco','manufacturing_complete') and w.order_type = 'make_to_stock')::int as mts_pending_tco,
    sum(greatest(j.quantity - coalesce(j.good_pieces,0),0)) filter (where j.status in ('ready','pending_compliance','assigned','in_setup','in_progress') and w.order_type = 'make_to_stock')::int as mts_open,
    string_agg(j.job_number || ' ' || j.status || coalesce(' @'||m.name,''), ', ') filter (where j.status in ('ready','pending_compliance','assigned','in_setup','in_progress')) as open_jobs
  from jobs j join work_orders w on w.id = j.work_order_id left join machines m on m.id = j.assigned_machine_id
  group by j.component_id
),
recv as (select bt.material_type || '|' || bt.stud_series || '|' || bt.stud_length as bkey, sum(mr.quantity)::int as received
           from material_receiving mr join blank_types bt on bt.id = mr.blank_type_id where mr.category = 'blank' group by 1),
used as (select s.bkey, sum(coalesce(j.good_pieces,0))::int as made from jobs j join studs s on s.id = j.component_id
          where j.status <> 'cancelled' and coalesce(j.actual_end, j.production_start, j.setup_start, j.created_at) >= '2026-06-25' group by s.bkey)
select st.part_number as stud, split_part(st.bkey,'|',1) as matl, split_part(st.bkey,'|',2) as series,
  a.qty_12m::int as qty_12m, a.cust_12m, a.cust_500plus,
  round(100.0 * a.top1_qty / nullif(a.qty_12m,0)) as top1_pct, coalesce(c.name, t.top_cust::text) as top_customer,
  round((a.qty_12m - a.top1_qty) / 12.0) as mo_demand_ex_top1,
  (coalesce(i.stud_avail,0) + coalesce(i.asm_avail,0))::int as avail_stud_plus_asm,
  coalesce(pp.mts_pending_tco,0) as mts_pending_tco, coalesce(pp.mts_open,0) as mts_open_jobs, pp.open_jobs,
  round((coalesce(i.stud_avail,0) + coalesce(i.asm_avail,0) + coalesce(pp.mts_pending_tco,0) + coalesce(pp.mts_open,0))
        / nullif((a.qty_12m - a.top1_qty)/12.0,0), 1) as cover_mo_with_pipeline,
  coalesce(r.received,0) - coalesce(u.made,0) as blanks_est
from studs st
join agg a on a.stud_id = st.id
left join top1 t on t.stud_id = st.id
left join customers c on c.customer_id = t.top_cust::text
left join inv i on i.stud_id = st.id
left join pipe pp on pp.stud_id = st.id
left join recv r on r.bkey = st.bkey
left join used u on u.bkey = st.bkey
where a.qty_12m - a.top1_qty >= 1500
order by cover_mo_with_pipeline nulls first;
```
Blank estimate = blanks received since the 2026-06-25 opening count minus pieces produced since — an estimate; confirm on the rack.

**Other reads:** `v_customer_pricing_current` (name, tier), `scheduler_policies` (`is_active`), `v_job_first_run` (first-run flag), `v_wo_dates` (WO target vs Fishbowl due), `v_co_line_dates` (CO line target).

---

## 6. Snapshot of the board and open items (as of Oct 20 — verify live)

Placed or proposed in the Oct 15 and Oct 20 rounds:

- Mazak 5: SK-T26H (in setup, late) → SK-T26T → stainless wing studs (SK4C7W1, SK4C5W1, SK26C8W1) → steel wing studs (SK4-7W1, SK26-8W1). Bisco SK2600-8SW folded into SK26C8W1 (500 → 600) was proposed.
- Nexturn 4 (cups): ALIGN SK26CR → SK4C20C → SK4C10C → SK4C15C → SK4C14C → steel cups SK4C7, then proposed J-000378 SK4C8 ×5,000 (Fastenal) and a SK4C15 top-up (Fishbowl had 920 against Fastenal's 1,000 — Matt's call open).
- Nexturn 5 (studs): SK4SFW20 → SK4-10S → SK27-S6 → SK27CS6 (Airparts fold-in to 540 proposed) → J-000376 SK4C4S → SK4C9S (Giza 2027).
- Mazak 2: stainless run with SKFJ4-30SS ×500 slotted in (J-000386 now exists).
- Bolt Masters (stock runs from Oct 15): BM-5 SK4C2P → SK4C3P; BM-3 SK4-8P → SK4-9P → SK4-10P; BM-2 SK27CP4; BM-6 SK27CP2 ×10,000; BM-1 McFarlane SK4C18P/SK4-19P done, then SK4-15P (Fastenal) proposed; SK4C15P stock and SK4-16P were the suggested BM-1 fillers.

Open items:

- **ALIGN SK26CR** — J-000212 (18,000, target 11-18) was stuck on Nexturn 1 (down). Option raised: split ~9,000 to Nexturn 6. Matt's call open.
- **SK294186-2-180** (#5 flush stud, Irwin) — Fishbowl negative; proposed a ~500 stock run; which machine/program is not confirmed (likely the Mazaks, like SKFJ4-30SS).
- **Blanks:** 4000 stainless -7 blanks (SK4C7P) nearly gone — order before the next stainless run; 4000 SS -11 and 2700 SS -6 looked thin.
- J-000258 QL8-CS (Airsupply) — questioned on Oct 15/20 (Fishbowl had 2,591); it is now scheduled.

---

## 7. Rules from the organization that apply here

- PROD (`luzungoqfuplspzbqctb`) and Fishbowl are **read-only** for Claude; TEST (`ylzmyjjqibpbqbwjsnqj`) may take diagnostics and corrections. Anything for PROD is delivered as a file and applied by Matt after it passes on TEST.
- Work product is a draft until Matt approves it. Flag uncertainty; never invent part numbers, lead times or prices; say where a figure came from.
- STC/PMA and certification questions are ruled on by Quality (Roger Danforth).
- People: Matt (scheduler, admin); Roger (compliance — clears `pending_compliance`, TCO); Ashley Hall (Order Queue, creates COs/WOs from demand); Harry (IT/maintenance help, e.g. the NT-1 sensor); machinists Carlos Osorio, Patrick Recor, Jeff Branch.

## 8. App changes in flight (as of Oct 28)

- **D-HIST-02** (traveler archive in the Schedule modal, Uncle Bob and Armory Part History): views on PROD; code built on `feature/dhist-02`, awaiting Matt's Dev review and CC ship.
- **D-FB-56** (Create CO warns and asks a reason when Fishbowl has stock of a picked component) and **D-SCHED-31** (Job Pool refresh button): CC prompt delivered Oct 15; not in `main` as of Oct 28. TEST's `fb_convert_to_co` already carries the D-FB-56 check (TEST and PROD differ there).
