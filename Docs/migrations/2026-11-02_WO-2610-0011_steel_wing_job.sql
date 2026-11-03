/* ===========================================================================
   2026-11-02_WO-2610-0011_steel_wing_job.sql
   SkyNet MES - WO-2610-0011 (Aero Parts Africa, 300 x SK4002-5W): steel wing studs

   WHY
     SK4002-5W (Winged Stud - Steel) was built from the stainless SK4C5W2, so
     J-000341 made 450 stainless SK4C5W1. The BOM is now corrected in SkyNet
     (SK4002-5W -> SK4-5W2 -> SK4-5W1 + SK4-WING3 + SK2600CGP174, created Nov 2).

   WHAT (one transaction)
     1. New make-to-stock work order WO-2611-NNNN (next number, the app's rule)
        for the stainless line: the SK4C5W2 sub-assembly line and J-000341
        (450 good SK4C5W1, batches FLN-100361) move to it, so the stainless parts
        are stock and stay off Aero Parts Africa's order and certs.
     2. WO-2610-0011 gets a SK4-5W2 sub-assembly line (300) under SK4002-5W.
     3. New job J-NNNNNN: SK4-5W1 x 300 on that line, pending_compliance, routing
        copied from the part, current part documents snapshotted - the same
        writes as Edit Work Order > Add Component; the line's assembly routing
        (Assemble) is copied as Create Work Order does. Schedule it in the app once
        Compliance releases it (SK4-5W1 has no drawing on file yet).
     Audit rows for every write, marker WO-2610-0011-steel-wing.

   HOW TO RUN (Supabase SQL Editor, RLS toggle OFF, one block at a time)
     1. PREVIEW -> one row, expect preview_ok = true
     2. APPLY   -> one DO block; raises and changes nothing if a guard fails
     3. VERIFY  -> one row, expect verify_ok = true
   =========================================================================== */


/* ---------------------------------------------------------------------------
   1. PREVIEW (read-only)
   --------------------------------------------------------------------------- */
select
  (select string_agg(c.part_number, ', ' order by c.part_number) from assembly_bom b join parts c on c.id = b.component_id
    where b.assembly_id = (select id from parts where part_number = 'SK4002-5W'))                  as sk4002_5w_bom,
  (select string_agg(c.part_number, ', ' order by c.part_number) from assembly_bom b join parts c on c.id = b.component_id
    where b.assembly_id = (select id from parts where part_number = 'SK4-5W2'))                    as sk4_5w2_bom,
  (select count(*) from part_routing_steps r where r.part_id = (select id from parts where part_number = 'SK4-5W1') and r.is_active) as sk4_5w1_routing_steps,
  (select count(*) from part_documents d where d.part_id = (select id from parts where part_number = 'SK4-5W1') and d.is_current) as sk4_5w1_documents,
  (select string_agg(p.part_number || ' x' || a.quantity, ', ' order by a.created_at) from work_order_assemblies a join parts p on p.id = a.assembly_id
    where a.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce')                                as wo_lines_now,
  (select j.job_number || ' ' || j.status || ' good ' || j.good_pieces from jobs j where j.id = 'a57a5a9d-2d1c-4608-8716-9201debb0880') as j000341,
  'J-' || lpad(((select coalesce(max(substring(job_number from '^J-([0-9]+)$')::bigint), 0) from jobs where job_number ~ '^J-[0-9]+$') + 1)::text, 6, '0') as next_job,
  'WO-' || to_char(now() at time zone 'America/New_York', 'YYMM') || '-' ||
    lpad(((select coalesce(max(split_part(wo_number, '-', 3)::int), 0) from work_orders
            where wo_number like 'WO-' || to_char(now() at time zone 'America/New_York', 'YYMM') || '-%') + 1)::text, 4, '0') as next_stock_wo,
  (    (select count(*) from assembly_bom b join parts c on c.id = b.component_id
         where b.assembly_id = (select id from parts where part_number = 'SK4002-5W') and c.part_number = 'SK4-5W2') = 1
   and (select count(*) from assembly_bom b join parts c on c.id = b.component_id
         where b.assembly_id = (select id from parts where part_number = 'SK4002-5W') and c.part_number = 'SK4C5W2') = 0
   and (select count(*) from assembly_bom b join parts c on c.id = b.component_id
         where b.assembly_id = (select id from parts where part_number = 'SK4-5W2') and c.part_number = 'SK4-5W1') = 1
   and (select count(*) from part_routing_steps r where r.part_id = (select id from parts where part_number = 'SK4-5W1') and r.is_active) > 0
   and (select count(*) from work_order_assemblies a where a.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce') = 2
   and (select count(*) from jobs j where j.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce') = 1
   and (select j.work_order_assembly_id from jobs j where j.id = 'a57a5a9d-2d1c-4608-8716-9201debb0880') = '58903719-f77f-4a23-b782-5f12ffe0d196'
  )                                                                                                as preview_ok;


/* ---------------------------------------------------------------------------
   2. APPLY
   --------------------------------------------------------------------------- */
do $$
declare
  v_marker    text := 'WO-2610-0011-steel-wing';
  v_file      text := '2026-11-02_WO-2610-0011_steel_wing_job.sql';
  v_wo        uuid := 'a7a08c15-3640-4ff9-aa57-955bbdd817ce';   /* WO-2610-0011 */
  v_top_woa   uuid := '5a305fe2-0f06-42ce-9f17-f978241cb807';   /* SK4002-5W line */
  v_ss_woa    uuid := '58903719-f77f-4a23-b782-5f12ffe0d196';   /* SK4C5W2 line (stainless) */
  v_j341      uuid := 'a57a5a9d-2d1c-4608-8716-9201debb0880';   /* J-000341 */
  v_actor     uuid;
  v_w1        uuid;
  v_w2        uuid;
  v_ss_w2     uuid;
  v_wo_row    work_orders%rowtype;
  v_ss_row    work_order_assemblies%rowtype;
  v_j341_row  jobs%rowtype;
  v_prefix    text;
  v_stock_wo  uuid;
  v_stock_num text;
  v_new_woa   uuid;
  v_job_id    uuid;
  v_job_num   text;
  v_steps     integer;
  v_docs      integer;
  v_wocj      integer;
begin
  v_actor := coalesce(
    (select p.id from profiles p where p.username = 'mbowers' and p.role = 'admin'),
    (select p.id from profiles p where p.username = 'mabowers84'));
  if v_actor is null then raise exception 'steel wing job: actor profile not found'; end if;

  v_w1    := (select id from parts where part_number = 'SK4-5W1');
  v_w2    := (select id from parts where part_number = 'SK4-5W2');
  v_ss_w2 := (select id from parts where part_number = 'SK4C5W2');
  if v_w1 is null or v_w2 is null then raise exception 'SK4-5W1 / SK4-5W2 not found - nothing changed'; end if;
  if not exists (select 1 from assembly_bom where assembly_id = v_w2 and component_id = v_w1) then
    raise exception 'SK4-5W2 BOM does not contain SK4-5W1 - nothing changed';
  end if;
  if not exists (select 1 from assembly_bom b join parts a on a.id = b.assembly_id where a.part_number = 'SK4002-5W' and b.component_id = v_w2)
     or exists (select 1 from assembly_bom b join parts a on a.id = b.assembly_id where a.part_number = 'SK4002-5W' and b.component_id = v_ss_w2) then
    raise exception 'SK4002-5W BOM is not SK4-5W2-only (stainless line still present or steel line missing) - nothing changed';
  end if;

  v_wo_row := (select w from work_orders w where w.id = v_wo for update);
  if v_wo_row.wo_number is distinct from 'WO-2610-0011' or v_wo_row.status in ('cancelled', 'complete', 'closed') then
    raise exception 'WO-2610-0011 not in expected state (%, %) - nothing changed', v_wo_row.wo_number, v_wo_row.status;
  end if;

  v_ss_row := (select a from work_order_assemblies a where a.id = v_ss_woa for update);
  if v_ss_row.work_order_id is distinct from v_wo or v_ss_row.assembly_id is distinct from v_ss_w2
     or v_ss_row.parent_work_order_assembly_id is distinct from v_top_woa then
    raise exception 'SK4C5W2 line not in expected state - nothing changed';
  end if;

  v_j341_row := (select j from jobs j where j.id = v_j341 for update);
  if v_j341_row.job_number is distinct from 'J-000341' or v_j341_row.work_order_id is distinct from v_wo
     or v_j341_row.work_order_assembly_id is distinct from v_ss_woa then
    raise exception 'J-000341 not in expected state - nothing changed';
  end if;

  if (select count(*) from jobs where work_order_id = v_wo) <> 1 then
    raise exception 'WO-2610-0011 has more than J-000341 on it - nothing changed';
  end if;
  if exists (select 1 from work_order_assemblies where work_order_id = v_wo and assembly_id = v_w2) then
    raise exception 'WO-2610-0011 already has a SK4-5W2 line - nothing changed';
  end if;

  /* ---- 1. stock work order for the stainless line ---- */
  v_prefix := 'WO-' || to_char(now() at time zone 'America/New_York', 'YYMM') || '-';
  v_stock_num := v_prefix || lpad(((select coalesce(max(split_part(wo_number, '-', 3)::int), 0)
                                      from work_orders where wo_number like v_prefix || '%') + 1)::text, 4, '0');

  insert into work_orders (wo_number, customer, priority, status, order_type, order_quantity, notes, created_by, created_at, updated_at)
  values (v_stock_num, null, 'normal', 'pending', 'make_to_stock', v_ss_row.quantity,
          'Stock for J-000341 (450 x SK4C5W1 stainless), moved off WO-2610-0011: SK4002-5W was built from the stainless SK4C5W2 by mistake.',
          v_actor, now(), now())
  returning id into v_stock_wo;

  update work_order_assemblies
     set work_order_id = v_stock_wo,
         parent_work_order_assembly_id = null
   where id = v_ss_woa;

  update jobs
     set work_order_id = v_stock_wo,
         updated_at    = now()
   where id = v_j341;

  update work_order_component_jobs
     set work_order_id = v_stock_wo
   where job_id = v_j341 and work_order_id = v_wo;
  get diagnostics v_wocj = row_count;

  /* ---- 2. SK4-5W2 line on WO-2610-0011 ---- */
  insert into work_order_assemblies (work_order_id, assembly_id, quantity, order_quantity, status, parent_work_order_assembly_id)
  values (v_wo, v_w2, 300, 300, 'pending', v_top_woa)
  returning id into v_new_woa;

  /* assembly routing for the line, as Create Work Order copies it */
  insert into work_order_assembly_routing_steps (work_order_assembly_id, step_order, step_name, step_type, station, status)
  select v_new_woa, r.step_order, r.step_name, r.step_type, r.default_station, 'pending'
    from part_routing_steps r
   where r.part_id = v_w2 and r.is_active
   order by r.step_order;

  /* ---- 3. SK4-5W1 job (the Edit Work Order > Add Component writes) ---- */
  v_job_num := 'J-' || lpad(((select coalesce(max(substring(job_number from '^J-([0-9]+)$')::bigint), 0)
                                from jobs where job_number ~ '^J-[0-9]+$') + 1)::text, 6, '0');

  insert into jobs (job_number, work_order_id, work_order_assembly_id, component_id, quantity, status, is_maintenance)
  values (v_job_num, v_wo, v_new_woa, v_w1, 300, 'pending_compliance', false)
  returning id into v_job_id;

  insert into job_routing_steps (job_id, step_order, step_name, step_type, station, status)
  select v_job_id, r.step_order, r.step_name, r.step_type, r.default_station, 'pending'
    from part_routing_steps r
   where r.part_id = v_w1 and r.is_active
   order by r.step_order;
  get diagnostics v_steps = row_count;

  insert into job_documents (job_id, document_type_id, file_name, file_url, file_size, mime_type, uploaded_by, status, source)
  select v_job_id, d.document_type_id, d.file_name, d.file_url, d.file_size, d.mime_type, v_actor, 'approved', 'part_pulled_forward'
    from part_documents d
   where d.part_id = v_w1 and d.is_current;
  get diagnostics v_docs = row_count;

  /* ---- audit ---- */
  insert into audit_logs (event_type, job_id, operator_id, details) values
  ('wo_structure_correction', v_j341, v_actor, jsonb_build_object(
     'job_number', 'J-000341', 'from_work_order', 'WO-2610-0011', 'to_work_order', v_stock_num,
     'moved_line', 'SK4C5W2 x' || v_ss_row.quantity, 'work_order_component_jobs_moved', v_wocj,
     'reason', 'SK4002-5W (steel) was built from the stainless SK4C5W2; J-000341 made 450 SK4C5W1 stainless - now stock',
     'marker', v_marker, 'correction', v_file)),
  ('job_created_by_sql', v_job_id, v_actor, jsonb_build_object(
     'job_number', v_job_num, 'work_order', 'WO-2610-0011', 'part', 'SK4-5W1', 'quantity', 300,
     'work_order_assembly', 'SK4-5W2 x300 under SK4002-5W', 'routing_steps', v_steps, 'documents', v_docs,
     'reason', 'Steel wing studs for SK4002-5W after the BOM correction',
     'marker', v_marker, 'correction', v_file));
end $$;


/* ---------------------------------------------------------------------------
   3. VERIFY. Expect verify_ok = true.
   --------------------------------------------------------------------------- */
select
  (select string_agg(p.part_number || ' x' || a.quantity, ', ' order by a.created_at) from work_order_assemblies a join parts p on p.id = a.assembly_id
    where a.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce')                                as wo_2610_0011_lines,
  (select string_agg(j.job_number || ' ' || p.part_number || ' x' || j.quantity || ' ' || j.status, ', ') from jobs j join parts p on p.id = j.component_id
    where j.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce')                                as wo_2610_0011_jobs,
  (select w.wo_number || ' (' || w.order_type || ')' from jobs j join work_orders w on w.id = j.work_order_id
    where j.id = 'a57a5a9d-2d1c-4608-8716-9201debb0880')                                           as j000341_now_on,
  (select count(*) from job_routing_steps s join jobs j on j.id = s.job_id
    where j.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce')                                as new_job_routing_steps,
  (select count(*) from audit_logs l where l.details->>'marker' = 'WO-2610-0011-steel-wing')       as audit_rows,
  (    (select count(*) from jobs j join parts p on p.id = j.component_id
         where j.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce') = 1
   and (select count(*) from jobs j join parts p on p.id = j.component_id
         where j.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce' and p.part_number = 'SK4-5W1'
           and j.quantity = 300 and j.status = 'pending_compliance') = 1
   and (select count(*) from work_order_assemblies a join parts p on p.id = a.assembly_id
         where a.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce' and p.part_number = 'SK4C5W2') = 0
   and (select count(*) from work_order_assemblies a join parts p on p.id = a.assembly_id
         where a.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce' and p.part_number = 'SK4-5W2'
           and a.parent_work_order_assembly_id = '5a305fe2-0f06-42ce-9f17-f978241cb807') = 1
   and (select w.order_type from jobs j join work_orders w on w.id = j.work_order_id
         where j.id = 'a57a5a9d-2d1c-4608-8716-9201debb0880') = 'make_to_stock'
   and (select count(*) from job_routing_steps s join jobs j on j.id = s.job_id
         where j.work_order_id = 'a7a08c15-3640-4ff9-aa57-955bbdd817ce') > 0
   and (select count(*) from audit_logs l where l.details->>'marker' = 'WO-2610-0011-steel-wing') = 2
  )                                                                                                as verify_ok;
