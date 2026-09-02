/* 2026-09-02_advance_stranded_mfg_complete.sql
   Jobs stranded at manufacturing_complete with every finishing batch already
   resolved (approved or rejected). Advances each through the same rule as
   resolveNextStatusAfterFinishing: a pending/in-progress external routing step
   -> ready_for_outsourcing, otherwise pending_tco (assembly module is off).
   Entering pending_tco fires the SKY65 fulfillment trigger, which caps each
   allocation at the CO line's remaining quantity. Dry run by default.
   TEST first, then PROD. Run each block on its own. */

/* Block 1 - the sweep function (dry run unless told otherwise) */
CREATE OR REPLACE FUNCTION public.advance_stranded_mfg_complete(p_dry_run boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid    uuid := auth.uid();
  v_now    timestamptz := now();
  v_row    record;
  v_next   text;
  v_done   jsonb := '[]'::jsonb;
  v_held   jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NOT NULL AND NOT user_has_role(v_uid, 'admin', 'compliance') THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  FOR v_row IN
    SELECT j.id, j.job_number::text AS job_number, w.wo_number::text AS wo_number, p.part_number::text AS part_number,
           j.actual_end,
           (SELECT count(*) FROM finishing_sends f WHERE f.job_id = j.id)::int AS batches,
           (SELECT count(*) FROM finishing_sends f WHERE f.job_id = j.id
              AND (f.compliance_status IS NULL OR f.compliance_status = 'pending_compliance'))::int AS unresolved,
           EXISTS (SELECT 1 FROM job_routing_steps s WHERE s.job_id = j.id AND s.step_type = 'external'
                     AND s.status IN ('pending', 'in_progress')) AS external_pending,
           (SELECT jsonb_agg(jsonb_build_object('co_number', o.co_number, 'line', l.line_number,
                     'ordered', l.quantity_ordered, 'fulfilled', l.quantity_fulfilled,
                     'remaining', greatest(0, l.quantity_ordered - l.quantity_fulfilled), 'allocated', a.quantity_allocated))
              FROM customer_order_allocations a
              JOIN customer_order_lines l ON l.id = a.customer_order_line_id
              JOIN customer_orders o ON o.id = l.customer_order_id
             WHERE a.work_order_id = j.work_order_id AND a.is_active) AS allocations
    FROM jobs j
    JOIN work_orders w ON w.id = j.work_order_id
    LEFT JOIN parts p ON p.id = j.component_id
    WHERE j.status = 'manufacturing_complete'
      AND NOT coalesce(j.is_maintenance, false)
      AND NOT j.is_standalone_finishing
      AND w.status <> 'complete'
    ORDER BY j.actual_end NULLS LAST
  LOOP
    IF v_row.unresolved > 0 THEN
      v_held := v_held || jsonb_build_object('job_number', v_row.job_number, 'wo_number', v_row.wo_number,
                 'part_number', v_row.part_number, 'reason', format('%s batch(es) awaiting compliance', v_row.unresolved));
      CONTINUE;
    END IF;

    v_next := CASE WHEN v_row.external_pending THEN 'ready_for_outsourcing' ELSE 'pending_tco' END;

    IF NOT p_dry_run THEN
      UPDATE jobs SET status = v_next, updated_at = v_now WHERE id = v_row.id;
      INSERT INTO audit_logs (event_type, job_id, machine_id, operator_id, details)
      VALUES ('mfg_complete_strand_advanced', v_row.id, NULL, v_uid,
              jsonb_build_object('job_number', v_row.job_number, 'wo_number', v_row.wo_number,
                                 'from', 'manufacturing_complete', 'to', v_next,
                                 'batches', v_row.batches, 'mfg_complete_at', v_row.actual_end));
    END IF;

    v_done := v_done || jsonb_build_object('job_number', v_row.job_number, 'wo_number', v_row.wo_number,
               'part_number', v_row.part_number, 'to', v_next, 'batches', v_row.batches,
               'mfg_complete', to_char(v_row.actual_end AT TIME ZONE 'America/New_York', 'Mon DD'),
               'allocations', coalesce(v_row.allocations, '[]'::jsonb));
  END LOOP;

  RETURN jsonb_build_object('dry_run', p_dry_run, 'ran_at', v_now,
                            'advanced_count', jsonb_array_length(v_done), 'advanced', v_done,
                            'held_count', jsonb_array_length(v_held), 'held', v_held);
END;
$$;

REVOKE ALL ON FUNCTION public.advance_stranded_mfg_complete(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_stranded_mfg_complete(boolean) TO authenticated, service_role;

/* Block 2 - preview, one row per job it would advance, with the CO lines the
   SKY65 trigger will fulfill (remaining = what the cap allows). Review the
   remaining column: a line already at 0 gets nothing. */
SELECT a->>'job_number' AS job, a->>'wo_number' AS wo, a->>'part_number' AS part, a->>'to' AS next_status,
       a->>'mfg_complete' AS mfg_complete, a->>'batches' AS batches,
       (SELECT string_agg(al->>'co_number' || ' L' || (al->>'line') || ' rem ' || (al->>'remaining') || '/' || (al->>'ordered'), ' · ')
          FROM jsonb_array_elements(a->'allocations') al) AS co_lines
FROM advance_stranded_mfg_complete(true) r, jsonb_array_elements(r->'advanced') a
ORDER BY a->>'mfg_complete';

/* Block 3 - the sweep */
SELECT r->>'advanced_count' AS advanced, r->>'held_count' AS held, r->'held' AS held_jobs
FROM advance_stranded_mfg_complete(false) r;

/* Block 4 - verify: nothing stranded remains except held batches, and
   fulfillment stamped on every advanced job */
SELECT count(*) FILTER (WHERE j.status = 'manufacturing_complete') AS still_mfg_complete,
       count(*) FILTER (WHERE j.status = 'pending_tco' AND j.co_fulfillment_applied_at >= now() - interval '10 minutes') AS advanced_and_fulfilled,
       count(*) FILTER (WHERE j.status = 'pending_tco' AND j.co_fulfillment_applied_at IS NULL) AS pending_tco_without_fulfillment_stamp
FROM jobs j
JOIN work_orders w ON w.id = j.work_order_id
WHERE w.status <> 'complete' AND NOT coalesce(j.is_maintenance, false) AND NOT j.is_standalone_finishing;
