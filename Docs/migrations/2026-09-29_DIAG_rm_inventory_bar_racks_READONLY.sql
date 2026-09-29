-- =====================================================================================
-- 2026-09-29  DIAG — Raw Material Inventory discrepancies (lot 2587 + every bar rack)
-- READ-ONLY. SELECT statements only. Safe on PROD (luzungoqfuplspzbqctb) and TEST.
-- Supabase SQL Editor: run ONE block at a time (only the last result set is returned).
-- Every block is aggregated or filtered to stay under the editor's 100-row limit.
-- Results quoted in the 2026-09-29 findings were taken from PROD at ~17:30 UTC.
-- =====================================================================================


-- ---------------------------------------------------------------------------
-- BLOCK 0  The availability definition the Inventory tab reads (D-AVAIL-01)
--          available_bars   = quantity - SUM(usage.quantity_used) + SUM(approved adjustment_delta)
--          available_inches = quantity*len - SUM(usage.quantity_used_inches) + SUM(delta)*len
--          NOTE the two columns disagree whenever a usage row was keyed at a length
--          other than the receipt's (a 48" piece from a 144" bar is 1 bar / 0.33 bar).
-- ---------------------------------------------------------------------------
select pg_get_viewdef('public.material_availability'::regclass, true) as viewdef;


-- ---------------------------------------------------------------------------
-- BLOCK 1  Lot 2587 — the three receipts behind the two UI lines
--          UI groups on (rack, type, size, BAR LENGTH, lot)  -> 144" line (2 receipts) + 48" line (1 receipt)
-- ---------------------------------------------------------------------------
select mr.id, mr.received_at, mr.po_number, mr.quantity as received, mr.bar_length_inches as len, mr.price_per_bar, mr.rack, mr.notes,
       v.used_bars, v.used_inches, v.adjustment_delta as adj, v.available_bars, v.available_inches,
       round(mr.quantity - v.used_inches / mr.bar_length_inches + v.adjustment_delta, 1) as avail_bars_inch_basis
from material_receiving mr join material_availability v on v.material_receiving_id = mr.id
where mr.lot_number = '2587' and mr.material_type = '41L40 Steel' and mr.bar_size = '0.375 dia'
order by mr.received_at, mr.bar_length_inches;


-- ---------------------------------------------------------------------------
-- BLOCK 2  Lot 2587 — the full usage ledger (which receipt each pull was charged to, at what length)
--          recv NULL = pre-count checkout (before the 6/11 opening-load stamp), correctly excluded.
-- ---------------------------------------------------------------------------
select mu.used_at, j.job_number, p.part_number, m.code as machine, m.max_bar_length,
       left(mu.material_receiving_id::text, 8) as recv, mr.bar_length_inches as recv_len,
       mu.quantity_used as bars_charged, mu.quantity_used_inches as inches,
       case when mu.quantity_used > 0 then round(mu.quantity_used_inches / mu.quantity_used) end as keyed_len,
       round(mu.quantity_used_inches / nullif(mr.bar_length_inches, 0), 2) as receipt_bars_equiv,
       jm.lot_number as job_lot_now, jm.bar_size as job_size_now, mu.notes, pr.full_name as used_by
from material_usage mu
left join jobs j on j.id = mu.job_id
left join parts p on p.id = j.component_id
left join machines m on m.id = j.assigned_machine_id
left join material_receiving mr on mr.id = mu.material_receiving_id
left join job_materials jm on jm.job_id = mu.job_id
left join profiles pr on pr.id = mu.used_by
where mu.lot_number = '2587'
order by mu.used_at;


-- ---------------------------------------------------------------------------
-- BLOCK 3  Lot 2587 — approved cycle-count adjustments (the invisible "+14" on the 48" line)
-- ---------------------------------------------------------------------------
select a.requested_at, left(a.material_receiving_id::text, 8) as recv, mr.bar_length_inches as len,
       a.counted_bars, a.system_bars_at_count, a.adjustment_delta, a.financial_impact, a.reason, a.status,
       rq.full_name as requested_by, rv.full_name as reviewed_by, left(a.count_session_id::text, 8) as session
from inventory_adjustment_requests a
join material_receiving mr on mr.id = a.material_receiving_id
left join profiles rq on rq.id = a.requested_by
left join profiles rv on rv.id = a.reviewed_by
where a.lot_number = '2587'
order by a.requested_at;


-- ---------------------------------------------------------------------------
-- BLOCK 4  Lot 2587 — reconciliation flag history
-- ---------------------------------------------------------------------------
select f.raised_at, f.flag_type, left(f.material_receiving_id::text, 8) as recv, j.job_number, f.quantity_delta,
       f.status, f.occurrence_count, f.resolved_at, f.resolution_notes
from material_reconciliation_flags f left join jobs j on j.id = f.job_id
where f.lot_number = '2587'
order by f.raised_at;


-- ---------------------------------------------------------------------------
-- BLOCK 5  Bar racks — population summary
-- ---------------------------------------------------------------------------
with r as (
  select mr.*, v.used_bars, v.adjustment_delta, v.available_bars, v.available_inches
  from material_receiving mr join material_availability v on v.material_receiving_id = mr.id
  where mr.category = 'bar'
), lots as (
  select material_type, bar_size, lot_number,
         count(*) as receipts,
         count(distinct coalesce(bar_length_inches::text, 'null')) as lengths,
         count(distinct coalesce(rack, 'staging')) as racks,
         count(distinct received_at) as distinct_received_at,
         sum(available_bars) as avail_bars,
         bool_or(available_bars < 0) as any_neg_receipt
  from r group by 1, 2, 3
)
select
  (select count(*) from r)                                                              as bar_receipts,
  (select count(*) from lots)                                                           as lots,
  (select count(*) from lots where receipts > 1)                                        as multi_receipt_lots,
  (select count(*) from lots where lengths > 1)                                         as lots_shown_as_2plus_lines_by_length,
  (select count(*) from lots where racks > 1)                                           as lots_split_by_rack,
  (select count(*) from lots where receipts > 1 and distinct_received_at < receipts)    as lots_with_same_timestamp_receipts,
  (select count(*) from lots where avail_bars < 0)                                      as lots_net_negative,
  (select count(*) from lots where any_neg_receipt)                                     as lots_with_a_negative_receipt,
  (select count(*) from r where available_bars < 0)                                     as negative_receipts,
  (select count(*) from r where quantity = 0)                                           as zero_qty_discovery_stubs,
  (select count(*) from r where price_per_bar is null)                                  as receipts_no_price;


-- ---------------------------------------------------------------------------
-- BLOCK 6  Bar racks — every UI line of a lot that renders as >1 line, or is negative anywhere
--          avail_bars = what the screen shows; avail_bars_by_inches = same receipts on the inch basis
-- ---------------------------------------------------------------------------
with r as (
  select mr.*, v.used_bars, v.used_inches, v.adjustment_delta, v.available_bars, v.available_inches
  from material_receiving mr join material_availability v on v.material_receiving_id = mr.id
  where mr.category = 'bar'
), lines as (
  select material_type, bar_size, lot_number, coalesce(rack, 'Staging') as rack, bar_length_inches as len,
         count(*) as receipts, sum(quantity) as recd, sum(used_bars) as used, sum(adjustment_delta) as adj,
         sum(available_bars) as avail_bars,
         round(sum(available_inches) / nullif(max(bar_length_inches), 0), 1) as avail_bars_by_inches,
         bool_or(available_bars < 0) as neg_receipt
  from r group by 1, 2, 3, 4, 5
), lots as (
  select material_type, bar_size, lot_number, count(*) as ui_lines, sum(avail_bars) as lot_avail, bool_or(neg_receipt) as any_neg
  from lines group by 1, 2, 3
)
select l.material_type, l.bar_size, l.lot_number, l.rack, l.len, l.receipts, l.recd, l.used, l.adj,
       l.avail_bars, l.avail_bars_by_inches, l.neg_receipt, lo.ui_lines, lo.lot_avail
from lines l join lots lo using (material_type, bar_size, lot_number)
where lo.ui_lines > 1 or lo.any_neg or lo.lot_avail < 0
order by l.material_type, l.bar_size, l.lot_number, l.len;


-- ---------------------------------------------------------------------------
-- BLOCK 7  Every bar usage row classified against the receipt it was charged to
--          Class 5 is the systemic driver: 48"/72" pieces charged as whole 144" bars.
-- ---------------------------------------------------------------------------
with u as (
  select mu.*, mr.bar_length_inches as recv_len, mr.quantity as recv_qty,
         case when mu.quantity_used > 0 then mu.quantity_used_inches / mu.quantity_used end as per_bar_len
  from material_usage mu
  left join material_receiving mr on mr.id = mu.material_receiving_id
  left join job_materials jm on jm.job_id = mu.job_id
  where coalesce(mr.category, 'bar') = 'bar' and coalesce(jm.material_type, '') not ilike 'Blank%'
)
select
  case
    when material_receiving_id is null            then '1 unlinked (no receipt) - not counted anywhere'
    when recv_qty = 0                             then '2 charged to a 0-qty discovery stub'
    when coalesce(quantity_used_inches, 0) = 0    then '3 linked, length unknown (inches 0/null)'
    when abs(per_bar_len - recv_len) < 1          then '4 linked, length matches receipt'
    when per_bar_len < recv_len                   then '5 linked, keyed SHORTER than receipt (48 on 144)'
    else                                               '6 linked, keyed LONGER than receipt'
  end as class,
  count(*) as rows, sum(quantity_used) as bars_charged, round(sum(quantity_used_inches)) as inches,
  count(distinct lot_number) as lots, count(distinct job_id) as jobs,
  round(sum(case when recv_len > 0 and coalesce(quantity_used_inches, 0) > 0
                 then quantity_used - quantity_used_inches / recv_len else 0 end), 1) as bars_overstated_vs_inch_basis
from u
group by 1 order by 1;


-- ---------------------------------------------------------------------------
-- BLOCK 8  Class 5 by lot: how many bars the bar-count basis overstates vs inches, and which machines drove it
--          (machines.max_bar_length = 48 on every Mazak; GN-1 loads 72")
-- ---------------------------------------------------------------------------
with u as (
  select mu.*, mr.material_type, mr.bar_size, mr.bar_length_inches as recv_len, j.job_number, m.code as machine, m.max_bar_length,
         mu.quantity_used_inches / nullif(mu.quantity_used, 0) as per_bar_len
  from material_usage mu join material_receiving mr on mr.id = mu.material_receiving_id
  left join jobs j on j.id = mu.job_id left join machines m on m.id = j.assigned_machine_id
  where mr.category = 'bar' and mu.quantity_used > 0 and coalesce(mu.quantity_used_inches, 0) > 0
)
select material_type, bar_size, lot_number, recv_len,
       count(*) as rows, sum(quantity_used) as bars_charged, round(sum(quantity_used_inches) / recv_len, 1) as bars_by_inches,
       round(sum(quantity_used) - sum(quantity_used_inches) / recv_len, 1) as overstated,
       string_agg(distinct round(per_bar_len)::text, '/') as keyed_lengths,
       string_agg(distinct machine || coalesce(' (max ' || max_bar_length || ')', ''), ', ') as machines,
       count(distinct job_number) as jobs
from u where per_bar_len < recv_len - 1
group by 1, 2, 3, 4 order by overstated desc;


-- ---------------------------------------------------------------------------
-- BLOCK 9  Phantom / cross-charged usage: the job's material record now says a different lot, type or size
--          (kiosk "remove material" deletes job_materials + material_loads but never the usage row)
-- ---------------------------------------------------------------------------
select j.job_number, j.status, mu.lot_number as usage_lot, mr.material_type as recv_type, mr.bar_size as recv_size,
       jm.lot_number as job_lot_now, jm.material_type as job_type_now, jm.bar_size as job_size_now, jm.bars_loaded,
       count(*) as rows, sum(mu.quantity_used) as bars, min(mu.used_at)::date as first_use, string_agg(distinct coalesce(mu.notes, ''), ' | ') as notes
from material_usage mu join material_receiving mr on mr.id = mu.material_receiving_id
left join jobs j on j.id = mu.job_id left join job_materials jm on jm.job_id = mu.job_id
where mr.category = 'bar'
  and (jm.lot_number is distinct from mu.lot_number or jm.material_type is distinct from mr.material_type or jm.bar_size is distinct from mr.bar_size)
group by 1, 2, 3, 4, 5, 6, 7, 8, 9 order by first_use;


-- ---------------------------------------------------------------------------
-- BLOCK 10  Per-job balance: usage rows vs job_materials.bars_loaded (bars only)
-- ---------------------------------------------------------------------------
with per_job as (
  select j.id, j.job_number, jm.lot_number as jm_lot, jm.bars_loaded, coalesce(sum(mu.quantity_used), 0) as usage_bars
  from jobs j join job_materials jm on jm.job_id = j.id
  left join material_usage mu on mu.job_id = j.id
  where jm.material_type not ilike 'Blank%'
  group by 1, 2, 3, 4
)
select case when usage_bars = bars_loaded then 'usage = bars_loaded'
            when usage_bars > bars_loaded then 'usage > bars_loaded (over-charged)'
            else 'usage < bars_loaded (under-charged)' end as class,
       count(*) as jobs, sum(bars_loaded) as bars_loaded, sum(usage_bars) as usage_bars,
       string_agg(job_number || ' (' || coalesce(jm_lot, '-') || ': ' || bars_loaded || ' loaded / ' || usage_bars || ' charged)', ', ' order by job_number)
         filter (where usage_bars <> bars_loaded) as detail
from per_job group by 1 order by 1;


-- ---------------------------------------------------------------------------
-- BLOCK 11  Unlinked bar usage: why each group has no receipt
-- ---------------------------------------------------------------------------
with u as (
  select mu.*, jm.material_type as jm_type, jm.bar_size as jm_size, j.job_number
  from material_usage mu left join jobs j on j.id = mu.job_id left join job_materials jm on jm.job_id = mu.job_id
  where mu.material_receiving_id is null and coalesce(jm.material_type, '') not ilike 'Blank%'
)
select
  case
    when u.lot_number is null then 'no lot on usage row'
    when not exists (select 1 from material_receiving mr where mr.lot_number = u.lot_number) then 'lot never received'
    when not exists (select 1 from material_receiving mr where mr.lot_number = u.lot_number and mr.material_type = u.jm_type and mr.bar_size = u.jm_size) then 'lot received under a different type/size'
    when exists (select 1 from material_receiving mr where mr.lot_number = u.lot_number and mr.material_type = u.jm_type and mr.bar_size = u.jm_size and mr.received_at <= u.used_at) then 'MISSED LINK - receipt predates usage'
    else 'pre-count usage (before receipt stamp) - correctly excluded'
  end as class,
  count(*) as rows, sum(quantity_used) as bars, string_agg(distinct coalesce(u.lot_number, '(none)') || ' ' || u.job_number, ', ') as detail
from u group by 1 order by 1;


-- ---------------------------------------------------------------------------
-- BLOCK 12  Which accounting basis predicted the physical counts?
--           For each approved count session x (lot, length bucket): counted vs system-at-count (bar basis)
--           vs the inch basis recomputed at that moment. Lower err = better model.
--           CORRECTED 2026-09-29: only a bucket's FIRST approved count is compared. Earlier approved
--           deltas were frozen against the bar basis, so adding them to an inch-basis balance
--           double-counts; the original version of this block did that for later counts.
-- ---------------------------------------------------------------------------
with adj as (
  select a.*, mr.bar_length_inches as len
  from inventory_adjustment_requests a join material_receiving mr on mr.id = a.material_receiving_id
  where a.status = 'approved' and mr.category = 'bar'
), bucket as (
  select count_session_id, material_type, bar_size, lot_number, len, min(requested_at) as at,
         sum(counted_bars) as counted, sum(system_bars_at_count) as system_bars, array_agg(material_receiving_id) as recv_ids
  from adj group by 1, 2, 3, 4, 5
), inch_basis as (
  select b.*,
    (select sum(mr.quantity) from material_receiving mr where mr.id = any(b.recv_ids)) as recd,
    (select coalesce(sum(mu.quantity_used_inches), 0) from material_usage mu where mu.material_receiving_id = any(b.recv_ids) and mu.used_at < b.at) as used_in,
    (select coalesce(sum(mu.quantity_used), 0) from material_usage mu where mu.material_receiving_id = any(b.recv_ids) and mu.used_at < b.at) as used_bars,
    (select coalesce(sum(mu.quantity_used), 0) from material_usage mu where mu.material_receiving_id = any(b.recv_ids) and mu.used_at < b.at and coalesce(mu.quantity_used_inches, 0) = 0) as used_bars_no_inches,
    (select coalesce(sum(p.adjustment_delta), 0) from inventory_adjustment_requests p where p.material_receiving_id = any(b.recv_ids) and p.status = 'approved' and p.reviewed_at < b.at) as prior_adj
  from bucket b
)
select at::date as count_date, material_type, bar_size, lot_number, len, counted, system_bars,
       round(recd - used_in / len - used_bars_no_inches + prior_adj, 1) as inch_basis,
       abs(counted - system_bars) as err_bar_basis,
       round(abs(counted - (recd - used_in / len - used_bars_no_inches + prior_adj)), 1) as err_inch_basis
from inch_basis
where used_bars > 0 and prior_adj = 0
order by at, material_type, lot_number, len;


-- ---------------------------------------------------------------------------
-- BLOCK 13  How far the screen is off RIGHT NOW (corrected 2026-09-29)
--           Anchored on each length bucket's last approved count: usage AFTER that count is
--           re-measured in inches; usage before it is left alone, because the count already
--           absorbed it. The original version added bar-basis count deltas to a lifetime
--           inch-basis ledger and overstated the gap (it reported ~3,927 vs 3,173 bars).
--           Buckets never counted are measured over their whole life.
-- ---------------------------------------------------------------------------
with b as (
  select mr.material_type, mr.bar_size, mr.lot_number, mr.bar_length_inches as len, array_agg(mr.id) as ids
  from material_receiving mr where mr.category = 'bar' group by 1, 2, 3, 4
), last_count as (
  select b.*, (select max(a.requested_at) from inventory_adjustment_requests a
                where a.status = 'approved' and a.material_receiving_id = any(b.ids)) as counted_at
  from b
), err as (
  select lc.*,
    (select coalesce(sum(mu.quantity_used - case when coalesce(mu.quantity_used_inches, 0) > 0
                                                 then mu.quantity_used_inches / lc.len else mu.quantity_used end), 0)
       from material_usage mu
      where mu.material_receiving_id = any(lc.ids) and (lc.counted_at is null or mu.used_at > lc.counted_at)) as overstated_since_anchor,
    (select coalesce(sum(mu.quantity_used - case when coalesce(mu.quantity_used_inches, 0) > 0
                                                 then mu.quantity_used_inches / lc.len else mu.quantity_used end), 0)
       from material_usage mu where mu.material_receiving_id = any(lc.ids)) as overstated_lifetime,
    (select sum(v.available_bars) from material_availability v where v.material_receiving_id = any(lc.ids)) as screen_bars
  from last_count lc
)
select
  count(*)                                                                        as buckets,
  count(*) filter (where counted_at is not null)                                  as buckets_with_a_count,
  round(sum(screen_bars), 1)                                                      as screen_bars_total,
  round(sum(screen_bars + overstated_since_anchor), 1)                            as estimated_bars_total,
  round(sum(overstated_lifetime), 1)                                              as lifetime_overstated_bars,
  round(sum(overstated_lifetime) - sum(overstated_since_anchor), 1)               as already_absorbed_by_counts,
  round(sum(overstated_since_anchor), 1)                                          as screen_currently_low_by,
  count(*) filter (where overstated_since_anchor > 0.5)                           as buckets_currently_low,
  string_agg(lot_number || ' ' || len || '": ' || round(screen_bars, 1) || ' shown, ~'
             || round(screen_bars + overstated_since_anchor, 1) || ' est', '; ' order by overstated_since_anchor desc)
    filter (where overstated_since_anchor > 3)                                    as biggest
from err;


-- ---------------------------------------------------------------------------
-- BLOCK 14  Approved bar adjustments overall, and the share sitting on the over-charged lots
-- ---------------------------------------------------------------------------
with adj as (
  select a.lot_number, mr.bar_length_inches as len, a.adjustment_delta, a.financial_impact, mr.quantity as recv_qty
  from inventory_adjustment_requests a join material_receiving mr on mr.id = a.material_receiving_id
  where a.status = 'approved' and mr.category = 'bar'
), over as (
  select mr.lot_number
  from material_usage mu join material_receiving mr on mr.id = mu.material_receiving_id
  where mr.category = 'bar' and mu.quantity_used > 0 and coalesce(mu.quantity_used_inches, 0) > 0
    and mu.quantity_used_inches / mu.quantity_used < mr.bar_length_inches - 1
  group by 1
)
select
  (select count(*) from adj)                                                                    as approved_bar_adjustments,
  (select sum(adjustment_delta) filter (where adjustment_delta > 0) from adj)                   as bars_added_by_counts,
  (select sum(adjustment_delta) filter (where adjustment_delta < 0) from adj)                   as bars_removed_by_counts,
  (select round(sum(financial_impact), 2) from adj)                                             as net_financial_impact,
  (select round(sum(financial_impact) filter (where financial_impact > 0), 2) from adj)         as positive_impact,
  (select sum(adjustment_delta) from adj where lot_number in (select lot_number from over) and len = 144) as delta_on_overcharged_lots_144,
  (select round(sum(financial_impact), 2) from adj where lot_number in (select lot_number from over))     as impact_on_overcharged_lots,
  (select count(*) from adj where recv_qty = 0)                                                 as adjustments_landed_on_zero_qty_stubs;


-- ---------------------------------------------------------------------------
-- BLOCK 15  Leftovers to re-point during the correction: 144" loads charged to 48" receipts, usage on 0-qty stubs
-- ---------------------------------------------------------------------------
select case when mr.quantity = 0 then 'on 0-qty stub' else 'keyed longer than receipt' end as class,
       mr.material_type, mr.bar_size, mr.lot_number, mr.bar_length_inches as recv_len, j.job_number,
       mu.quantity_used as bars, mu.quantity_used_inches as inches, mu.used_at::date as d
from material_usage mu join material_receiving mr on mr.id = mu.material_receiving_id left join jobs j on j.id = mu.job_id
where mr.category = 'bar' and mu.quantity_used > 0
  and (mr.quantity = 0 or (coalesce(mu.quantity_used_inches, 0) > 0 and mu.quantity_used_inches / mu.quantity_used > mr.bar_length_inches + 1))
order by 1, mu.used_at;


-- ---------------------------------------------------------------------------
-- BLOCK 16  Hygiene checks
-- ---------------------------------------------------------------------------
select 'opening-load rack note != rack column' as check, count(*) as n,
       string_agg(lot_number || ' ' || rack || ' vs note:' || substring(notes from 'line \d+, (R\d)'), ', ') as detail
from material_receiving where category = 'bar' and notes ~ 'line \d+, R\d' and substring(notes from 'line \d+, (R\d)') is distinct from rack
union all
select 'usage rows with NULL lot (voided 0-bar rows excluded)', count(*), string_agg(distinct j.job_number || ' x' || mu.quantity_used, ', ')
from material_usage mu left join jobs j on j.id = mu.job_id where mu.lot_number is null and mu.quantity_used > 0
union all
select 'job_materials bar_length <= 12 (feet keyed?)', count(*), string_agg(j.job_number || ' len=' || jm.bar_length, ', ')
from job_materials jm join jobs j on j.id = jm.job_id where jm.bar_length is not null and jm.bar_length <= 12 and jm.material_type not ilike 'Blank%'
union all
select 'job_materials bar_length NULL (bars)', count(*), string_agg(j.job_number, ', ')
from job_materials jm join jobs j on j.id = jm.job_id where jm.bar_length is null and jm.material_type not ilike 'Blank%'
union all
select 'adjustment sessions whose one reason text was stamped on every line', count(*), string_agg(left(count_session_id::text, 8) || ' "' || reason || '" x' || n, ', ')
from (select count_session_id, reason, count(*) as n from inventory_adjustment_requests where reason is not null group by 1, 2 having count(*) > 1 and count(distinct lot_number) > 1) s
union all
select 'material_types that look like duplicates (Nylon)', count(*), string_agg(name, ' | ')
from material_types where name ilike '%nylon%';
