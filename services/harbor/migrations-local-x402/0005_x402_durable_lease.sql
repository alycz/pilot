ALTER TABLE x402_payments ADD COLUMN lease_acquired_at TEXT;

-- A legacy prepared row may have crashed after signing but before persisting
-- its blob. Treat every such row as signing-ambiguous so an upgrade can never
-- re-sign it.
UPDATE x402_payments
SET signing_started_at = COALESCE(signing_started_at, updated_at)
WHERE status = 'prepared';

-- Pre-lease nonterminal rows are preserved and quarantine their payer. They
-- cannot be safely collapsed when 0002 allowed duplicate active delegates.
CREATE TABLE x402_payer_quarantine (
  network TEXT NOT NULL,
  payer TEXT NOT NULL,
  reason TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  PRIMARY KEY (network, payer)
);

INSERT INTO x402_payer_quarantine (network, payer, reason, quarantined_at)
SELECT network, delegate, 'pre_lease_active_row', MAX(updated_at)
FROM x402_payments
WHERE status NOT IN ('failed', 'delivered')
GROUP BY network, delegate;

-- Replace the earlier draft index if a local development database applied it
-- before the durable lease/quarantine migration was introduced.
DROP INDEX IF EXISTS idx_x402_payments_active_payer;

-- Sequence-method payments stay globally leased to one active payment until
-- independent settlement or validated expiry reaches a terminal state.
CREATE UNIQUE INDEX idx_x402_payments_active_payer
  ON x402_payments (network, delegate)
  WHERE status NOT IN ('failed', 'delivered') AND lease_acquired_at IS NOT NULL;
