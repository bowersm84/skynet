/* ===========================================================================
   2026-10-27_D-PRICE-71_backup_table_rls.sql
   SkyNet MES - lock down price_items_cents_backup_dprice70 (D-PRICE-70 before-images)

   WHY
     D-PRICE-70 (2026-10-26) created public.price_items_cents_backup_dprice70 without
     enabling RLS. On both TEST and PROD it carries the default anon + authenticated
     grants, so anyone holding the browser's anon key can read, change or delete the
     2,951-row rollback record through the REST API. The RLS Guardrail workflow (TEST)
     fails on it: "RLS DISABLED - must be enabled for all public tables".

   WHAT
     Profile E (service-role only), the D-PRICE-40 / D-KSTC-37 pattern:
     RLS on, no policies, anon/authenticated grants revoked, table comment.
     The table is kept: it is the only before-image of the D-PRICE-70 rounding.
     Nothing in the app, no function and no view reads it; the SQL Editor and the
     service role still can.
     The repo side (allowlist entry in Docs/migrations/rls_guardrail.sql) ships via CC.

   HOW TO RUN (Supabase SQL Editor, RLS toggle OFF, one block at a time)
     1. PREVIEW -> one row, expect preview_ok = true
     2. APPLY   -> one DO block; raises and changes nothing if the guards fail
     3. VERIFY  -> one row, expect verify_ok = true
   TEST first, then PROD, same text.
   =========================================================================== */


/* ---------------------------------------------------------------------------
   1. PREVIEW (read-only). Expect preview_ok = true.
   --------------------------------------------------------------------------- */
select
  c.relrowsecurity                                                         as rls_enabled,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname)             as policy_count,
  (select count(*) from public.price_items_cents_backup_dprice70)          as row_count,
  (select count(*) from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name = c.relname
      and g.grantee in ('anon', 'authenticated'))                          as anon_auth_grants,
  (    not c.relrowsecurity
   and (select count(*) from public.price_items_cents_backup_dprice70) = 2951
  )                                                                        as preview_ok
from pg_class c
where c.oid = 'public.price_items_cents_backup_dprice70'::regclass;


/* ---------------------------------------------------------------------------
   2. APPLY
   --------------------------------------------------------------------------- */
do $$
declare
  v_rls  boolean;
  v_rows bigint;
begin
  v_rls  := (select c.relrowsecurity from pg_class c
              where c.oid = 'public.price_items_cents_backup_dprice70'::regclass);
  v_rows := (select count(*) from public.price_items_cents_backup_dprice70);

  if v_rls then
    raise exception 'D-PRICE-71: RLS is already enabled on price_items_cents_backup_dprice70 - nothing changed';
  end if;
  if v_rows <> 2951 then
    raise exception 'D-PRICE-71: expected 2951 before-image rows, found % - nothing changed', v_rows;
  end if;

  alter table public.price_items_cents_backup_dprice70 enable row level security;
  revoke all on table public.price_items_cents_backup_dprice70 from anon, authenticated;
  comment on table public.price_items_cents_backup_dprice70 is
    'D-PRICE-70 before-images: 2,951 list prices rounded to whole cents on 2026-10-26. Service-role only (D-PRICE-71): RLS on, no policies, no anon/authenticated grants; on the rls_guardrail.sql allowlist. Read from the SQL Editor only.';
end $$;


/* ---------------------------------------------------------------------------
   3. VERIFY. Expect verify_ok = true.
      guardrail_violations runs the guardrail's own test with the allowlist as it
      will read once CC's change lands: expect 0 on TEST.
   --------------------------------------------------------------------------- */
select
  c.relrowsecurity                                                         as rls_enabled,
  (select count(*) from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname)             as policy_count,
  (select count(*) from public.price_items_cents_backup_dprice70)          as row_count,
  (select count(*) from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name = c.relname
      and g.grantee in ('anon', 'authenticated'))                          as anon_auth_grants,
  (select count(*)
     from pg_class t join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relkind = 'r'
      and (   not t.relrowsecurity
           or (    not exists (select 1 from pg_policies p
                                where p.schemaname = 'public' and p.tablename = t.relname)
               and t.relname <> all (array['import_bom_staging', 'import_parts_staging',
                                           'pricing_counters', 'fb_shipment_lots',
                                           'price_items_cents_backup_dprice70']))))
                                                                           as guardrail_violations,
  (    c.relrowsecurity
   and (select count(*) from public.price_items_cents_backup_dprice70) = 2951
   and (select count(*) from information_schema.role_table_grants g
         where g.table_schema = 'public' and g.table_name = c.relname
           and g.grantee in ('anon', 'authenticated')) = 0
  )                                                                        as verify_ok
from pg_class c
where c.oid = 'public.price_items_cents_backup_dprice70'::regclass;
