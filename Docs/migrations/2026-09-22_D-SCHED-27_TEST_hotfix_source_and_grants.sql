-- =====================================================================================
-- 2026-09-22_D-SCHED-27_TEST_hotfix_source_and_grants.sql
-- Apply on TEST (ylzmyjjqibpbqbwjsnqj) after the v1.0 migration. NOT needed on PROD —
-- the corrected migration file (v1.1) already contains both fixes.
--
-- Gate §4 on TEST showed every seeded part labelled length_family_source = 'manual'
-- (0 / 0 / 305). Cause: the seed UPDATE changed the key from NULL, and the trigger's
-- manual-edit test ("key changed and source is not already manual") could not tell the
-- rule's own write from a human's. Keys and dashes are correct; only the label is wrong.
-- Gate §7 showed authenticated holding ALL privileges on the five views — Supabase default
-- privileges are inherited by new views; v1.0 granted SELECT but never revoked the rest.
--
-- Run one section at a time in the SQL Editor. §3 is EXPECTED to end in an ERROR — that
-- error message is the probe result and it rolls back its own writes (nothing is left on TEST).
-- =====================================================================================


-- ───────────── §1 Trigger function, corrected manual-edit detection ─────────────
--   • key changed and the caller did NOT also set the source in the same statement → manual
--   • key changed and the caller set a source (the seed writes rule_desc/rule_tail)   → respected
--   • key NULL and source 'manual'  → explicit opt-out ("this part has no family"); rule skipped
--   • key NULL and source NULL      → rule applies (fill-only, never overwrites a stored key)
create or replace function public.parts_length_family_fill()
returns trigger
language plpgsql
as $tg$
declare
  v_key    text;
  v_dash   integer;
  v_source text;
begin
  if tg_op = 'UPDATE'
     and new.length_family_key is distinct from old.length_family_key
     and new.length_family_key is not null
     and new.length_family_source is not distinct from old.length_family_source then
    new.length_family_source := 'manual';
    new.length_family_set_at := now();
    return new;
  end if;

  if new.length_family_key is not null then
    if new.length_family_set_at is null then
      new.length_family_set_at := now();
    end if;
    return new;
  end if;

  -- Explicit opt-out: a human cleared the key and said so.
  if new.length_family_source = 'manual' then
    return new;
  end if;

  if new.part_type is distinct from 'manufactured' then
    return new;
  end if;

  v_key    := (select f.length_family_key    from public.derive_length_family(new.part_number, new.description) f);
  v_dash   := (select f.length_dash          from public.derive_length_family(new.part_number, new.description) f);
  v_source := (select f.length_family_source from public.derive_length_family(new.part_number, new.description) f);

  if v_key is null then
    return new;
  end if;

  if v_source = 'rule_tail'
     and not exists (select 1 from public.parts p where p.length_family_key = v_key and p.id is distinct from new.id) then
    return new;
  end if;

  new.length_family_key    := v_key;
  new.length_dash          := v_dash;
  new.length_family_source := v_source;
  new.length_family_set_at := now();
  return new;
end
$tg$;

-- Gate §1
select proname, prosrc ~ 'is not distinct from old.length_family_source' as corrected
from pg_proc where proname = 'parts_length_family_fill';
-- Expect corrected = true.


-- ───────────── §2 Relabel the seed: source = what the rule says, where the key is the rule's ─────────────
-- The trigger fires only on UPDATE OF part_number/description/length_family_key, so this write does not trigger it.
update public.parts p
   set length_family_source = (select f.length_family_source from public.derive_length_family(p.part_number, p.description) f)
 where p.length_family_source = 'manual'
   and p.length_family_key = (select f.length_family_key from public.derive_length_family(p.part_number, p.description) f);

-- Gate §2
select (count(*) filter (where length_family_source = 'rule_desc'))::text || ' / ' ||
       (count(*) filter (where length_family_source = 'rule_tail'))::text || ' / ' ||
       (count(*) filter (where length_family_source = 'manual'))::text as rule_desc_rule_tail_manual,
       (select length_family_source from parts where part_number = 'SK4C4S')  as sk4c4s_expect_rule_desc,
       (select length_family_source from parts where part_number = 'SK26CS6') as sk26cs6_expect_rule_tail
from parts where length_family_key is not null;
-- Expect TEST: 198 / 107 / 0   (PROD will be 198 / 108 / 0).


-- ───────────── §3 Trigger probe — ENDS IN AN ERROR ON PURPOSE, leaves nothing behind ─────────────
do $probe$
declare
  s1 text; s2 text; s3 text; s4 text;
begin
  -- a) human edits the key without touching source → manual
  update public.parts set length_family_key = 'ZZPROBE#' where part_number = 'SK4C4S';
  s1 := (select length_family_key || ' / ' || length_family_source from public.parts where part_number = 'SK4C4S');

  -- b) human clears key and source → rule refills
  update public.parts set length_family_key = null, length_family_source = null where part_number = 'SK4C4S';
  s2 := (select length_family_key || ' / ' || length_dash || ' / ' || length_family_source from public.parts where part_number = 'SK4C4S');

  -- c) explicit opt-out → stays NULL
  update public.parts set length_family_key = null, length_family_source = 'manual' where part_number = 'SK4C4S';
  s3 := (select coalesce(length_family_key, 'NULL') || ' / ' || length_family_source from public.parts where part_number = 'SK4C4S');

  -- d) caller declares the source with the key → respected (this is the seed's path)
  update public.parts set length_family_key = 'SK4C#S', length_dash = 4, length_family_source = 'rule_desc' where part_number = 'SK4C4S';
  s4 := (select length_family_key || ' / ' || length_family_source from public.parts where part_number = 'SK4C4S');

  raise exception 'PROBE (rolled back) | a: % | b: % | c: % | d: %', s1, s2, s3, s4;
end
$probe$;
-- Expect the error text:
--   a: ZZPROBE# / manual | b: SK4C#S / 4 / rule_desc | c: NULL / manual | d: SK4C#S / rule_desc
-- Confirm nothing stuck:
select part_number, length_family_key, length_dash, length_family_source from parts where part_number = 'SK4C4S';
-- Expect SK4C#S / 4 / rule_desc (from §2), i.e. unchanged by the probe.


-- ───────────── §4 Grants: SELECT only for authenticated; nothing for anon/public ─────────────
revoke all on public.v_part_run_rates, public.v_length_family_machine_history, public.v_length_family_material,
               public.v_part_observed_material, public.v_job_first_run from authenticated, anon, public;
grant select on public.v_part_run_rates, public.v_length_family_machine_history, public.v_length_family_material,
                public.v_part_observed_material, public.v_job_first_run to authenticated;

-- Gate §4
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privs
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('v_part_run_rates','v_length_family_machine_history','v_length_family_material','v_part_observed_material','v_job_first_run')
  and grantee in ('authenticated', 'anon')
group by 1, 2 order by 1, 2;
-- Expect exactly five rows, all authenticated / SELECT. No anon rows.
