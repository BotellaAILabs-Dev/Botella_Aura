-- Campaigns can now be closed out automatically once no task can still run
-- (see server/campaigns/executor.service.ts). That transition is worth an
-- audit entry, and AuditAction had no value for it.
--
-- Additive only: adding a value to an enum cannot invalidate existing rows.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'CAMPAIGN_COMPLETED';
