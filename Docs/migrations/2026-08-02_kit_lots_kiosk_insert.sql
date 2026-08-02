-- Kit & STC Registry — kit_lots INSERT policy for the /kits bench station.
-- Applied to TEST 2026-08-02.
--
-- The bench runs on a kiosk JWT (kiosk-authenticate, 8h) and stamps
-- kit_lots.created_by with the PIN operator's profile id, so created_by never
-- equals auth.uid() — the same reality the D-RLS-DOWNTIME01 precedent records
-- for machine_downtime_logs. A created_by = auth.uid() style check would
-- therefore match zero rows and fail the insert silently.
--
-- The check that matters is source: entry may only create SkyNet-native rows.
-- Paper-transcription rows stay the loader's business.
--
-- UPDATE remains role-gated (admin/compliance/customer_service/scheduler), so
-- corrections to a logged row remain office work.

BEGIN;
DROP POLICY IF EXISTS kit_lots_insert_workflow ON public.kit_lots;
CREATE POLICY kit_lots_insert_kiosk ON public.kit_lots
  FOR INSERT TO authenticated
  WITH CHECK (source = 'skynet'::text);
COMMIT;
