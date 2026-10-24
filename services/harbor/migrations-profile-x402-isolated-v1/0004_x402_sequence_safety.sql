ALTER TABLE x402_payments ADD COLUMN signing_started_at TEXT;

-- Older amount-bearing rows must continue to consume the conservative maximum
-- fee reservation after the amount-plus-fee columns are introduced.
UPDATE x402_payments
SET fee_cap_drops = COALESCE(fee_cap_drops, 100),
    reserved_total_drops = COALESCE(reserved_total_drops, amount_drops + 100)
WHERE amount_drops IS NOT NULL;

-- A Testnet payer is a dedicated sequence authority, not a reusable credential
-- that can be scoped independently to multiple principals or owners.
CREATE UNIQUE INDEX idx_x402_payers_network_address
  ON x402_payers (network, payer);
