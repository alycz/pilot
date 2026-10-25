-- Additive, default-off persistence for native-XRPL issued-currency x402.
-- This migration does not mount a route or enable any live operation.

CREATE TABLE issued_x402_state (
  idempotency_key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  binding TEXT NOT NULL,
  payer TEXT NOT NULL,
  merchant_invoice_id TEXT NOT NULL UNIQUE,
  invoice_id TEXT NOT NULL UNIQUE CHECK (
    length(invoice_id) = 64 AND invoice_id NOT GLOB '*[^0-9A-F]*'
  ),
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 4294967295),
  approval_id TEXT NOT NULL UNIQUE,
  approval_digest TEXT NOT NULL UNIQUE CHECK (
    length(approval_digest) = 64 AND approval_digest NOT GLOB '*[^0-9A-F]*'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'reserved', 'signing', 'signed', 'uncertain', 'delivered'
  )),
  tx_hash TEXT CHECK (
    tx_hash IS NULL OR
    (length(tx_hash) = 64 AND tx_hash NOT GLOB '*[^0-9A-F]*')
  ),
  signed_blob TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (payer, sequence),
  CHECK (
    (status IN ('reserved', 'signing') AND tx_hash IS NULL
      AND signed_blob IS NULL AND result_json IS NULL)
    OR
    (status = 'signed' AND tx_hash IS NOT NULL
      AND signed_blob IS NOT NULL AND result_json IS NULL)
    OR
    (status = 'uncertain' AND result_json IS NULL
      AND ((tx_hash IS NULL AND signed_blob IS NULL)
        OR (tx_hash IS NOT NULL AND signed_blob IS NOT NULL)))
    OR
    (status = 'delivered' AND tx_hash IS NOT NULL
      AND signed_blob IS NOT NULL AND result_json IS NOT NULL)
  )
);

CREATE INDEX idx_issued_x402_state_payer_status
  ON issued_x402_state (payer, status);

CREATE TABLE issued_x402_budget (
  idempotency_key TEXT PRIMARY KEY,
  binding TEXT NOT NULL,
  payer TEXT NOT NULL,
  asset_key TEXT NOT NULL,
  amount TEXT NOT NULL,
  amount_atoms TEXT NOT NULL CHECK (
    length(amount_atoms) BETWEEN 1 AND 96 AND
    amount_atoms NOT GLOB '*[^0-9]*'
  ),
  fee_drops TEXT NOT NULL CHECK (
    length(fee_drops) BETWEEN 1 AND 19 AND
    fee_drops NOT GLOB '*[^0-9]*'
  ),
  budget_day TEXT NOT NULL CHECK (length(budget_day) = 10),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'uncertain', 'committed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_issued_x402_budget_payer_asset_day
  ON issued_x402_budget (payer, asset_key, budget_day, state);

-- Serializes the exact-BigInt aggregate check across Worker isolates. A
-- crashed holder stays fail-closed and must be explicitly reconciled; locks
-- are never stolen based only on elapsed time.
CREATE TABLE issued_x402_budget_locks (
  payer TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  acquired_at TEXT NOT NULL
);

-- Cross-table recovery journal. Each authority transition updates its own row
-- and this journal in one D1 batch. The journal never treats elapsed time as
-- proof that signing or settlement did not happen.
CREATE TABLE issued_x402_journal (
  idempotency_key TEXT PRIMARY KEY,
  payer TEXT NOT NULL,
  merchant_invoice_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  state_status TEXT NOT NULL CHECK (state_status IN (
    'reserved', 'signing', 'signed', 'uncertain', 'delivered'
  )),
  budget_state TEXT CHECK (budget_state IN (
    'reserved', 'uncertain', 'committed'
  )),
  tx_hash TEXT,
  result_json TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (idempotency_key) REFERENCES issued_x402_state(idempotency_key)
);
