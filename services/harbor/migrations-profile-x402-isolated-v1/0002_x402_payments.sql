CREATE TABLE x402_payments (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  delegate TEXT NOT NULL,
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'claimed', 'prepared', 'signed', 'settlement_unknown',
    'settled', 'delivered', 'failed'
  )),
  amount_drops INTEGER,
  caller_max_drops INTEGER,
  policy_per_call_cap_drops INTEGER,
  daily_cap_drops INTEGER,
  pay_to TEXT,
  invoice_id TEXT,
  requirements_json TEXT,
  transaction_json TEXT,
  signed_blob TEXT,
  hash TEXT,
  last_ledger_seq INTEGER,
  expires_at TEXT,
  reserved_at TEXT,
  signed_at TEXT,
  settlement_unknown_at TEXT,
  settled_at TEXT,
  delivered_at TEXT,
  failed_at TEXT,
  settlement_json TEXT,
  delivery_json TEXT,
  failure_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal, idempotency_key),
  UNIQUE (principal, network, invoice_id),
  CHECK (
    (status = 'claimed' AND amount_drops IS NULL)
    OR status = 'failed'
    OR (status NOT IN ('claimed', 'failed') AND amount_drops IS NOT NULL)
  )
);

CREATE INDEX idx_x402_payments_budget
  ON x402_payments (principal, owner, network, reserved_at, status);

CREATE UNIQUE INDEX idx_x402_payments_hash
  ON x402_payments (principal, hash)
  WHERE hash IS NOT NULL;
