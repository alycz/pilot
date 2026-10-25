CREATE TABLE ap4m_mandates (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'testnet'),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED')),
  execution_type TEXT NOT NULL CHECK (execution_type = 'DEFERRED'),
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  constraints_json TEXT NOT NULL,
  agent_public_jwk TEXT NOT NULL,
  agent_key_enc BLOB NOT NULL,
  agent_key_iv BLOB NOT NULL,
  claim_keys_enc BLOB NOT NULL,
  claim_keys_iv BLOB NOT NULL,
  claim_public_keys_json TEXT NOT NULL,
  prepared_json TEXT NOT NULL,
  l1_digest TEXT NOT NULL DEFAULT '',
  l2_digest TEXT NOT NULL DEFAULT '',
  vi_chain_enc BLOB,
  vi_chain_iv BLOB,
  setup_batch_hash TEXT,
  channels_json TEXT NOT NULL DEFAULT '[]',
  spent_usd TEXT NOT NULL DEFAULT '0',
  spent_microusd INTEGER NOT NULL DEFAULT 0 CHECK (spent_microusd >= 0),
  close_requested INTEGER NOT NULL DEFAULT 0 CHECK (close_requested IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal, owner, network, id)
);

CREATE INDEX idx_ap4m_mandates_principal_owner
  ON ap4m_mandates(principal, owner, network, status);

CREATE TABLE ap4m_spend (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  spend_day TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  amount_usd TEXT NOT NULL,
  amount_microusd INTEGER NOT NULL CHECK (amount_microusd >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
  receipt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (principal, mandate_id, idempotency_key),
  FOREIGN KEY (mandate_id) REFERENCES ap4m_mandates(id)
);

CREATE INDEX idx_ap4m_spend_daily
  ON ap4m_spend(principal, mandate_id, spend_day, status);

CREATE TABLE ap4m_receipts (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  mandate_id TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (principal, mandate_id, idempotency_key),
  FOREIGN KEY (mandate_id) REFERENCES ap4m_mandates(id)
);

CREATE INDEX idx_ap4m_receipts_mandate
  ON ap4m_receipts(principal, mandate_id, created_at);
