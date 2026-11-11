-- ============================================================================
-- S17 D1d — one check of the pulled lots, not two
-- 2026-11-11  ·  D-ASM-58 (Matt, testing on the tablet)
--
-- Before: starting a build with a lot combination never built before asked for
-- a second person's PIN at start, and the checklist's Component check step then
-- asked for a check of the same lots again. The second person at start also
-- could not see which lots had been chosen.
--
-- Now: the start-time second PIN is switched off. The Component check step is
-- the one check of the pulled lots, and its sign-off window shows the lots
-- being approved (screen change by CC, Batch D1 follow-up).
--
-- assembly_build_start already reads this setting; no function changes.
--
-- Applied on TEST by Claude on 2026-11-11 and probed in a rolled-back block: a
-- build started with a never-built lot combination and no second PIN.
-- PROD: with Batch D. Not yet.
--
-- Note for checklist approval: a checklist with no Component check step now has
-- no second look at the pulled lots at all. All four approved checklists on
-- TEST have one.
-- ============================================================================

UPDATE public.app_settings
   SET value = 'false'::jsonb, updated_at = now(),
       description = 'When true, starting a build with a lot combination never built before needs a second person''s PIN at start. Off since 2026-11-11 (D-ASM-58): the Component check step is the one check of the pulled lots.'
 WHERE key = 'assembly_lot_new_set_second_pin';

-- Verify: expect false.
SELECT key, value FROM public.app_settings WHERE key = 'assembly_lot_new_set_second_pin';
