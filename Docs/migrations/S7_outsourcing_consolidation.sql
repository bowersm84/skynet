-- Outsourcing Consolidation — Option B (group ID approach)
-- Adds consolidation_group_id to outbound_sends + a deferred constraint trigger
-- enforcing the president's traceability test: no group may span multiple material lots.

BEGIN;

-- 1. Column + index
ALTER TABLE public.outbound_sends
  ADD COLUMN IF NOT EXISTS consolidation_group_id uuid;

CREATE INDEX IF NOT EXISTS idx_outbound_sends_consolidation_group_id
  ON public.outbound_sends(consolidation_group_id)
  WHERE consolidation_group_id IS NOT NULL;

-- 2. Trigger function: every row in a group must share a non-null material lot.
-- Uses CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED so that multi-row inserts
-- in a single transaction are validated at COMMIT time — by which point all
-- sibling rows in the group are visible to the SELECT.
CREATE OR REPLACE FUNCTION enforce_consolidation_material_lot()
RETURNS TRIGGER AS $$
DECLARE
  distinct_lots integer;
  null_count integer;
BEGIN
  IF NEW.consolidation_group_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT
    COUNT(DISTINCT fs.material_lot_number),
    COUNT(*) FILTER (WHERE fs.material_lot_number IS NULL)
    INTO distinct_lots, null_count
    FROM public.outbound_sends os
    LEFT JOIN public.finishing_sends fs ON fs.id = os.finishing_send_id
    WHERE os.consolidation_group_id = NEW.consolidation_group_id;

  IF null_count > 0 THEN
    RAISE EXCEPTION
      'Consolidation group % contains row(s) with NULL material_lot_number — traceability gate failed',
      NEW.consolidation_group_id;
  END IF;
  IF distinct_lots > 1 THEN
    RAISE EXCEPTION
      'Consolidation group % spans multiple material lot numbers — traceability gate failed',
      NEW.consolidation_group_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_consolidation_material_lot ON public.outbound_sends;

CREATE CONSTRAINT TRIGGER trg_enforce_consolidation_material_lot
  AFTER INSERT OR UPDATE OF consolidation_group_id, finishing_send_id ON public.outbound_sends
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION enforce_consolidation_material_lot();

COMMIT;

-- Sanity check after apply: should return 0 rows pre-feature
SELECT consolidation_group_id, COUNT(*) cnt
FROM public.outbound_sends
WHERE consolidation_group_id IS NOT NULL
GROUP BY consolidation_group_id;