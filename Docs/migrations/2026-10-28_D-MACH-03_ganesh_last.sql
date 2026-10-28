/* ===========================================================================
   2026-10-28_D-MACH-03_ganesh_last.sql
   SkyNet MES - Ganesh 1 (GN-1) moves to the bottom of the machine lineup

   WHAT
     machines.display_order for GN-1: 8 -> 23, one past Bolt Master 6 (22), so it
     is the last production machine on the Schedule and on Mainframe. Finishing
     tanks and ovens (100+) are not in the Schedule and sit in their own Mainframe
     section, so they are unaffected. The kiosk machine pickers and the Production
     Display read the same order and follow it. No other machine moves; the gap at
     8 is left as is. Data only - no code change.

   HOW TO RUN (Supabase SQL Editor, RLS toggle OFF, one block at a time)
     1. PREVIEW -> one row, expect preview_ok = true
     2. APPLY   -> one DO block; raises and changes nothing if the guards fail
     3. VERIFY  -> one row, expect verify_ok = true
   TEST first, then PROD, same text.
   =========================================================================== */


/* ---------------------------------------------------------------------------
   1. PREVIEW (read-only)
   --------------------------------------------------------------------------- */
select
  (select display_order from machines where code = 'GN-1')                                as gn1_order_now,
  (select max(display_order) from machines where machine_type <> 'finishing')              as last_production_order,
  (select code from machines where machine_type <> 'finishing' order by display_order desc limit 1) as last_production_machine,
  (select count(*) from machines where display_order = 23)                                 as taken_23,
  (    (select display_order from machines where code = 'GN-1') = 8
   and (select max(display_order) from machines where machine_type <> 'finishing' and code <> 'GN-1') = 22
   and (select count(*) from machines where display_order = 23) = 0
  )                                                                                        as preview_ok;


/* ---------------------------------------------------------------------------
   2. APPLY
   --------------------------------------------------------------------------- */
do $$
declare
  v_gn1    machines%rowtype;
  v_max    integer;
  v_taken  integer;
begin
  v_gn1   := (select m from machines m where m.code = 'GN-1' for update);
  v_max   := (select max(display_order) from machines where machine_type <> 'finishing' and code <> 'GN-1');
  v_taken := (select count(*) from machines where display_order = 23);

  if v_gn1.id is null then raise exception 'D-MACH-03: GN-1 not found'; end if;
  if v_gn1.display_order <> 8 then
    raise exception 'D-MACH-03: GN-1 display_order is %, expected 8 - nothing changed', v_gn1.display_order;
  end if;
  if v_max <> 22 then
    raise exception 'D-MACH-03: last production machine is at %, expected 22 - nothing changed', v_max;
  end if;
  if v_taken <> 0 then
    raise exception 'D-MACH-03: display_order 23 already in use - nothing changed';
  end if;

  update machines
     set display_order = 23,
         updated_at    = now()
   where id = v_gn1.id;
end $$;


/* ---------------------------------------------------------------------------
   3. VERIFY. Expect verify_ok = true.
   --------------------------------------------------------------------------- */
select
  string_agg(code, ' > ' order by display_order) filter (where machine_type <> 'finishing') as production_lineup,
  (select display_order from machines where code = 'GN-1')                                  as gn1_order,
  (    (select code from machines where machine_type <> 'finishing' order by display_order desc limit 1) = 'GN-1'
   and (select display_order from machines where code = 'GN-1') = 23
   and (select count(*) from machines where display_order = 23) = 1
  )                                                                                          as verify_ok
from machines;
