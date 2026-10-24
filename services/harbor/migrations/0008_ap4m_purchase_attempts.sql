CREATE TABLE ap4m_purchase_attempts (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  merchant_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'claimed', 'prepared', 'signed', 'settlement_unknown',
    'settled', 'delivered', 'failed'
  )),
  spend_id TEXT,
  spend_day TEXT,
  amount_usd TEXT,
  amount_microusd INTEGER CHECK (amount_microusd IS NULL OR amount_microusd > 0),
  prepared_context_enc BLOB,
  prepared_context_iv BLOB,
  prepared_context_public_json TEXT,
  prepared_context_digest TEXT,
  lease_acquired_at TEXT NOT NULL,
  signing_started_at TEXT,
  signing_lease_token TEXT,
  first_eligible_ledger_index INTEGER CHECK (
    first_eligible_ledger_index IS NULL OR first_eligible_ledger_index > 0
  ),
  signed_blob TEXT,
  tx_hash TEXT,
  last_ledger_sequence INTEGER,
  settlement_unknown_at TEXT,
  settled_at TEXT,
  delivered_at TEXT,
  failed_at TEXT,
  ledger_index INTEGER,
  delivered_amount TEXT,
  receipt_id TEXT,
  merchant_response_json TEXT,
  merchant_response_at TEXT,
  result_json TEXT,
  failure_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal, mandate_id, idempotency_key),
  UNIQUE (spend_id),
  UNIQUE (tx_hash),
  FOREIGN KEY (mandate_id) REFERENCES ap4m_mandates(id),
  FOREIGN KEY (spend_id) REFERENCES ap4m_spend(id)
);

CREATE INDEX idx_ap4m_purchase_attempts_recovery
  ON ap4m_purchase_attempts(principal, status, updated_at);

CREATE INDEX idx_ap4m_purchase_attempts_mandate
  ON ap4m_purchase_attempts(principal, mandate_id, created_at);
