-- 2026-05-15_co_fulfillment_idempotency.sql
-- Adds idempotency guard for the auto-fulfill-on-RQ-advance flow.

ALTER TABLE job_shortfall_resolutions
ADD COLUMN IF NOT EXISTS fulfillment_applied_at timestamptz;

COMMENT ON COLUMN job_shortfall_resolutions.fulfillment_applied_at IS
'Timestamp set when the re-queue job''s good_pieces have been auto-distributed against this resolution''s WO active CO allocations. NULL = pending. Used to prevent double-fulfillment if the compliance-advance trigger fires twice (e.g. recall + re-approve).';
