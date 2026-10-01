/* ============================================================================================
   2026-10-01_pricing_manager_REVOKE_customer_service.sql   (PROD SQL Editor: paste the whole file, Run)
   Ends the temporary tier access granted by 2026-10-01_pricing_manager_GRANT_customer_service.sql:
   removes the pricing_manager additional role from the same people, leaving their other roles alone.
   April Braun keeps hers (she is not in the list). Re-running changes nothing.
   Expect: April Braun and the admins only.
   ============================================================================================ */
BEGIN;

UPDATE public.profiles
SET roles = array_remove(roles, 'pricing_manager')
WHERE full_name IN ('Ashley Hall', 'Peyton Marshall', 'Sawyer Griner', 'Zack Haggerty')
  AND 'pricing_manager' = ANY (COALESCE(roles, '{}'));

COMMIT;

SELECT full_name, role, roles FROM public.profiles
WHERE is_active AND (role = 'admin' OR 'pricing_manager' = ANY (COALESCE(roles, '{}')))
ORDER BY full_name;
