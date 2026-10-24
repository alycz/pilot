ALTER TABLE x402_payments ADD COLUMN fee_cap_drops INTEGER;
ALTER TABLE x402_payments ADD COLUMN reserved_total_drops INTEGER;

CREATE TABLE x402_payers (
  principal TEXT NOT NULL,
  owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'testnet'),
  payer TEXT NOT NULL,
  public_key TEXT NOT NULL,
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) > 16),
  iv BLOB NOT NULL CHECK (length(iv) = 12),
  status TEXT NOT NULL CHECK (status IN ('disabled', 'ready', 'suspended')),
  funded_ledger_index INTEGER,
  funded_balance_drops TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal, owner, network),
  CHECK (
    (funded_ledger_index IS NULL AND funded_balance_drops IS NULL)
    OR (funded_ledger_index IS NOT NULL AND funded_balance_drops IS NOT NULL)
  )
);
