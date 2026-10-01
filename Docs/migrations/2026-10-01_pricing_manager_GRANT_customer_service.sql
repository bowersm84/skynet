/* ============================================================================================
   2026-10-01_pricing_manager_GRANT_customer_service.sql   (PROD SQL Editor: paste the whole file, Run)
   Temporarily lets the customer service team set customer tiers in the Pricing Portal by adding the
   pricing_manager ADDITIONAL role (profiles.roles[]) - the same way April has it (D-PRICE-51).
   pricing_manager unlocks exactly two things: the "Set tier" button (pricing_set_customer_tier, checked
   server-side by _pricing_tier_roles()) and the Deviations tab. Nothing else.
   Edit the name list if needed; it must match profiles.full_name exactly. Re-running changes nothing.
   Undo: 2026-10-01_pricing_manager_REVOKE_customer_service.sql (same list).
   People see the change after refreshing the Pricing Portal.
   Expect: April Braun plus everyone in the list.
   ============================================================================================ */
BEGIN;

UPDATE public.profiles
SET roles = array_append(COALESCE(roles, '{}'), 'pricing_manager')
WHERE is_active
  AND full_name IN ('Ashley Hall', 'Peyton Marshall', 'Sawyer Griner', 'Zack Haggerty')
  AND NOT ('pricing_manager' = ANY (COALESCE(roles, '{}')));

COMMIT;

/* read back the saved state: everyone who can now set tiers */
SELECT full_name, role, roles FROM public.profiles
WHERE is_active AND (role = 'admin' OR 'pricing_manager' = ANY (COALESCE(roles, '{}')))
ORDER BY full_name;
