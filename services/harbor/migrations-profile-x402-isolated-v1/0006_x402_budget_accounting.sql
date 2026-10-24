ALTER TABLE x402_payments ADD COLUMN budget_consumed_drops INTEGER;
ALTER TABLE x402_payments ADD COLUMN budget_consumed_at TEXT;

-- Historical successful settlements did not persist the actual charged fee.
-- Backfill the conservative amount-plus-fee reservation on their settlement
-- day so an upgrade cannot silently reopen budget.
UPDATE x402_payments
SET budget_consumed_drops = reserved_total_drops,
    budget_consumed_at = COALESCE(settled_at, updated_at, reserved_at, created_at)
WHERE status IN ('settled', 'delivered')
  AND reserved_total_drops IS NOT NULL;

CREATE INDEX idx_x402_payments_budget_consumed
  ON x402_payments (principal, owner, network, budget_consumed_at);
