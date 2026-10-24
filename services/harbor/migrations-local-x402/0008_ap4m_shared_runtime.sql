-- Additive, offline-only schema for the inactive combined AP4M + x402
-- Worker profile. This migration is intentionally part of the isolated-x402
-- lineage so both rails share one D1 sequence authority.

-- Authoritative QN-2/QN-3/QN-4 schema, composed verbatim from the main
-- migration definitions because the combined Worker exposes those handlers.
CREATE TABLE qn_nonces (
  nonce TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE qn_wallet_events (
  tx_hash TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  delegate TEXT,
  tx_type TEXT NOT NULL,
  result TEXT NOT NULL,
  ledger_index INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  received_at TEXT NOT NULL
);

CREATE TABLE qn_watchdog_events (
  tx_hash TEXT PRIMARY KEY,
  account TEXT NOT NULL,
  delegate TEXT,
  class TEXT NOT NULL,
  flags_json TEXT NOT NULL,
  ledger_index INTEGER NOT NULL,
  close_time TEXT NOT NULL,
  action TEXT NOT NULL,
  received_at TEXT NOT NULL
);

ALTER TABLE links ADD COLUMN frozen_at TEXT;
ALTER TABLE links ADD COLUMN frozen_reason TEXT;
ALTER TABLE executions ADD COLUMN confirmed_by TEXT;
ALTER TABLE executions ADD COLUMN confirmed_at TEXT;

CREATE INDEX idx_qn_wallet_account ON qn_wallet_events(account);
CREATE INDEX idx_qn_watchdog_account ON qn_watchdog_events(account);

CREATE TABLE qn_rpc_counters (
  run_tag TEXT PRIMARY KEY,
  calls_quicknode INTEGER NOT NULL DEFAULT 0 CHECK (calls_quicknode >= 0),
  calls_fallback INTEGER NOT NULL DEFAULT 0 CHECK (calls_fallback >= 0),
  webhook_confirmations INTEGER NOT NULL DEFAULT 0 CHECK (webhook_confirmations >= 0),
  webhook_last_at TEXT,
  watchdog_ledgers_seen INTEGER NOT NULL DEFAULT 0 CHECK (watchdog_ledgers_seen >= 0),
  watchdog_last_ledger INTEGER CHECK (watchdog_last_ledger >= 0),
  watchdog_events INTEGER NOT NULL DEFAULT 0 CHECK (watchdog_events >= 0),
  watchdog_frozen_count INTEGER NOT NULL DEFAULT 0 CHECK (watchdog_frozen_count >= 0),
  updated_at TEXT NOT NULL
);

-- The isolated-x402 lineage predates the full v2 execution-lifetime schema,
-- but the combined AP4M worker must account against immutable execution
-- owner/network bindings. This compatibility relation exposes only that
-- authoritative subset; it does not claim local v1 supports v2 execution.
CREATE UNIQUE INDEX idx_local_execution_snapshot_parent
  ON executions(id, principal, build_id);

CREATE TABLE execution_snapshots (
  execution_id TEXT NOT NULL CHECK (length(execution_id) BETWEEN 1 AND 256),
  principal TEXT NOT NULL CHECK (
    length(principal) BETWEEN 1 AND 256 AND instr(principal, char(0)) = 0
  ),
  build_id TEXT NOT NULL CHECK (length(build_id) BETWEEN 1 AND 256),
  snapshot_owner TEXT NOT NULL CHECK (
    length(snapshot_owner) BETWEEN 25 AND 64 AND substr(snapshot_owner, 1, 1) = 'r' AND
    snapshot_owner NOT GLOB '*[^A-Za-z0-9]*'
  ),
  snapshot_network TEXT NOT NULL CHECK (snapshot_network IN ('testnet', 'devnet')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  PRIMARY KEY (execution_id, principal, build_id),
  UNIQUE (principal, execution_id),
  FOREIGN KEY (execution_id, principal, build_id)
    REFERENCES executions(id, principal, build_id),
  FOREIGN KEY (build_id) REFERENCES builds(id)
) WITHOUT ROWID;

CREATE INDEX idx_execution_snapshots_revision
  ON execution_snapshots(principal, build_id);

-- Legacy rows with empty identity columns cannot receive a defensible
-- immutable owner/network authority.
INSERT INTO execution_snapshots (
  execution_id, principal, build_id, snapshot_owner, snapshot_network, created_at
)
SELECT '', '', '', '', 'invalid', ''
WHERE EXISTS (
  SELECT 1 FROM executions execution
  WHERE length(execution.id) = 0 OR length(execution.principal) = 0
    OR length(execution.build_id) = 0
);

-- A missing build is an orphan. Abort instead of silently excluding it from
-- either the exact or payment-channel shared-cap query.
INSERT INTO execution_snapshots (
  execution_id, principal, build_id, snapshot_owner, snapshot_network, created_at
)
SELECT '', '', '', '', 'invalid', ''
WHERE EXISTS (
  SELECT 1 FROM executions execution
  WHERE NOT EXISTS (SELECT 1 FROM builds build WHERE build.id = execution.build_id)
);

-- An id that resolves only under another principal is not an attributable
-- execution. Invalid networks are equally unsafe for this Testnet/devnet
-- compatibility snapshot.
INSERT INTO execution_snapshots (
  execution_id, principal, build_id, snapshot_owner, snapshot_network, created_at
)
SELECT '', '', '', '', 'invalid', ''
WHERE EXISTS (
  SELECT 1
  FROM executions execution
  JOIN builds build ON build.id = execution.build_id
  WHERE build.principal <> execution.principal
    OR build.network NOT IN ('testnet', 'devnet')
);

INSERT INTO execution_snapshots (
  execution_id, principal, build_id, snapshot_owner, snapshot_network, created_at
)
SELECT execution.id, execution.principal, execution.build_id,
  build.owner, build.network, execution.created_at
FROM executions execution
JOIN builds build
  ON build.principal = execution.principal AND build.id = execution.build_id;

CREATE TRIGGER validate_local_execution_snapshot_insert
BEFORE INSERT ON execution_snapshots
WHEN NOT EXISTS (
  SELECT 1
  FROM executions execution
  JOIN builds build
    ON build.principal = execution.principal AND build.id = execution.build_id
  WHERE execution.id = NEW.execution_id AND execution.principal = NEW.principal
    AND execution.build_id = NEW.build_id AND build.owner = NEW.snapshot_owner
    AND build.network = NEW.snapshot_network
)
BEGIN
  SELECT RAISE(ABORT, 'local execution snapshot binding is invalid');
END;

CREATE TRIGGER reject_local_execution_snapshot_update
BEFORE UPDATE ON execution_snapshots
BEGIN
  SELECT RAISE(ABORT, 'local execution snapshots are immutable');
END;

CREATE TRIGGER reject_local_execution_snapshot_delete
BEFORE DELETE ON execution_snapshots
BEGIN
  SELECT RAISE(ABORT, 'local execution snapshots are immutable');
END;

CREATE TRIGGER validate_local_execution_insert
BEFORE INSERT ON executions
WHEN NOT EXISTS (
  SELECT 1 FROM builds build
  WHERE build.principal = NEW.principal AND build.id = NEW.build_id
    AND build.network IN ('testnet', 'devnet')
)
BEGIN
  SELECT RAISE(ABORT, 'local execution build binding is invalid');
END;

CREATE TRIGGER snapshot_local_execution_insert
AFTER INSERT ON executions
BEGIN
  INSERT INTO execution_snapshots (
    execution_id, principal, build_id, snapshot_owner, snapshot_network, created_at
  )
  SELECT NEW.id, NEW.principal, NEW.build_id, build.owner, build.network, NEW.created_at
  FROM builds build
  WHERE build.principal = NEW.principal AND build.id = NEW.build_id;
END;

CREATE TRIGGER reject_local_execution_binding_update
BEFORE UPDATE OF principal, build_id ON executions
WHEN OLD.principal <> NEW.principal OR OLD.build_id <> NEW.build_id
BEGIN
  SELECT RAISE(ABORT, 'local execution snapshot binding is immutable');
END;

CREATE TRIGGER reject_snapshotted_execution_delete
BEFORE DELETE ON executions
WHEN EXISTS (
  SELECT 1 FROM execution_snapshots snapshot
  WHERE snapshot.principal = OLD.principal AND snapshot.execution_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'snapshotted local execution is immutable');
END;

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

CREATE TABLE ap4m_channel_claims (
  principal TEXT NOT NULL CHECK (
    length(principal) BETWEEN 1 AND 256 AND instr(principal, char(0)) = 0
  ),
  mandate_id TEXT NOT NULL CHECK (
    length(mandate_id) BETWEEN 1 AND 128 AND
    substr(mandate_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    mandate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  merchant_id TEXT NOT NULL CHECK (
    length(merchant_id) BETWEEN 1 AND 128 AND
    substr(merchant_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    merchant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  channel_id TEXT NOT NULL CHECK (
    length(channel_id) = 64 AND channel_id NOT GLOB '*[^0-9A-F]*'
  ),
  payer TEXT NOT NULL CHECK (
    length(payer) BETWEEN 25 AND 64 AND substr(payer, 1, 1) = 'r' AND
    payer NOT GLOB '*[^A-Za-z0-9]*'
  ),
  channel_amount_drops TEXT NOT NULL CHECK (
    length(channel_amount_drops) BETWEEN 1 AND 18 AND
    channel_amount_drops NOT GLOB '*[^0-9]*' AND
    channel_amount_drops <> '0' AND substr(channel_amount_drops, 1, 1) <> '0' AND
    (length(channel_amount_drops) < 18 OR channel_amount_drops <= '100000000000000000')
  ),
  public_key TEXT NOT NULL CHECK (
    length(public_key) = 66 AND substr(public_key, 1, 2) IN ('ED', '02', '03') AND
    public_key NOT GLOB '*[^0-9A-F]*'
  ),
  cumulative_drops TEXT NOT NULL DEFAULT '0' CHECK (
    length(cumulative_drops) BETWEEN 1 AND 18 AND
    cumulative_drops NOT GLOB '*[^0-9]*' AND
    (cumulative_drops = '0' OR substr(cumulative_drops, 1, 1) <> '0') AND
    (length(cumulative_drops) < 18 OR cumulative_drops <= '100000000000000000')
  ),
  last_price_drops TEXT,
  last_idempotency_key TEXT,
  signature TEXT,
  pending_idempotency_key TEXT,
  pending_price_drops TEXT,
  pending_cumulative_drops TEXT,
  pending_token TEXT,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (principal, channel_id),
  UNIQUE (principal, mandate_id, merchant_id),
  FOREIGN KEY (mandate_id) REFERENCES ap4m_mandates(id),
  CHECK (CAST(cumulative_drops AS INTEGER) <= CAST(channel_amount_drops AS INTEGER)),
  CHECK (
    (last_price_drops IS NULL AND last_idempotency_key IS NULL AND signature IS NULL)
    OR
    (last_price_drops IS NOT NULL AND
      length(last_price_drops) BETWEEN 1 AND 18 AND
      last_price_drops NOT GLOB '*[^0-9]*' AND last_price_drops <> '0' AND
      substr(last_price_drops, 1, 1) <> '0' AND
      (length(last_price_drops) < 18 OR last_price_drops <= '100000000000000000') AND
      CAST(last_price_drops AS INTEGER) <= CAST(cumulative_drops AS INTEGER) AND
      last_idempotency_key IS NOT NULL AND length(last_idempotency_key) BETWEEN 1 AND 128 AND
      substr(last_idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
      last_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      signature IS NOT NULL AND length(signature) BETWEEN 2 AND 256 AND
      length(signature) % 2 = 0 AND signature NOT GLOB '*[^0-9A-F]*')
  ),
  CHECK (
    (pending_idempotency_key IS NULL AND pending_price_drops IS NULL AND
      pending_cumulative_drops IS NULL AND pending_token IS NULL)
    OR
    (pending_idempotency_key IS NOT NULL AND length(pending_idempotency_key) BETWEEN 1 AND 128 AND
      substr(pending_idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
      pending_idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*' AND
      pending_price_drops IS NOT NULL AND length(pending_price_drops) BETWEEN 1 AND 18 AND
      pending_price_drops NOT GLOB '*[^0-9]*' AND pending_price_drops <> '0' AND
      substr(pending_price_drops, 1, 1) <> '0' AND
      (length(pending_price_drops) < 18 OR pending_price_drops <= '100000000000000000') AND
      pending_cumulative_drops IS NOT NULL AND length(pending_cumulative_drops) BETWEEN 1 AND 18 AND
      pending_cumulative_drops NOT GLOB '*[^0-9]*' AND pending_cumulative_drops <> '0' AND
      substr(pending_cumulative_drops, 1, 1) <> '0' AND
      (length(pending_cumulative_drops) < 18 OR pending_cumulative_drops <= '100000000000000000') AND
      CAST(pending_cumulative_drops AS INTEGER) =
        CAST(cumulative_drops AS INTEGER) + CAST(pending_price_drops AS INTEGER) AND
      CAST(pending_cumulative_drops AS INTEGER) <= CAST(channel_amount_drops AS INTEGER) AND
      pending_token IS NOT NULL AND length(pending_token) = 64 AND
      pending_token NOT GLOB '*[^0-9A-F]*')
  )
) WITHOUT ROWID;

CREATE INDEX idx_ap4m_channel_claims_mandate
  ON ap4m_channel_claims(principal, mandate_id, merchant_id, channel_id);

CREATE TABLE ap4m_channel_claim_attempts (
  principal TEXT NOT NULL CHECK (
    length(principal) BETWEEN 1 AND 256 AND instr(principal, char(0)) = 0
  ),
  channel_id TEXT NOT NULL CHECK (
    length(channel_id) = 64 AND channel_id NOT GLOB '*[^0-9A-F]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 128 AND
    substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  merchant_id TEXT NOT NULL CHECK (
    length(merchant_id) BETWEEN 1 AND 128 AND
    substr(merchant_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    merchant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  price_drops TEXT NOT NULL CHECK (
    length(price_drops) BETWEEN 1 AND 18 AND price_drops NOT GLOB '*[^0-9]*' AND
    price_drops <> '0' AND substr(price_drops, 1, 1) <> '0' AND
    (length(price_drops) < 18 OR price_drops <= '100000000000000000')
  ),
  cumulative_drops TEXT NOT NULL CHECK (
    length(cumulative_drops) BETWEEN 1 AND 18 AND cumulative_drops NOT GLOB '*[^0-9]*' AND
    cumulative_drops <> '0' AND substr(cumulative_drops, 1, 1) <> '0' AND
    (length(cumulative_drops) < 18 OR cumulative_drops <= '100000000000000000')
  ),
  claim_token TEXT NOT NULL CHECK (
    length(claim_token) = 64 AND claim_token NOT GLOB '*[^0-9A-F]*'
  ),
  public_key TEXT NOT NULL CHECK (
    length(public_key) = 66 AND substr(public_key, 1, 2) IN ('ED', '02', '03') AND
    public_key NOT GLOB '*[^0-9A-F]*'
  ),
  signature TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (principal, channel_id, idempotency_key),
  FOREIGN KEY (principal, channel_id) REFERENCES ap4m_channel_claims(principal, channel_id),
  CHECK (
    (status = 'pending' AND signature IS NULL)
    OR
    (status = 'completed' AND signature IS NOT NULL AND
      length(signature) BETWEEN 2 AND 256 AND length(signature) % 2 = 0 AND
      signature NOT GLOB '*[^0-9A-F]*')
  )
) WITHOUT ROWID;

CREATE TABLE ap4m_paychan_purchase_attempts (
  principal TEXT NOT NULL CHECK (
    length(principal) BETWEEN 1 AND 256 AND instr(principal, char(0)) = 0
  ),
  mandate_id TEXT NOT NULL CHECK (
    length(mandate_id) BETWEEN 1 AND 128 AND
    substr(mandate_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    mandate_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 1 AND 128 AND
    substr(idempotency_key, 1, 1) GLOB '[A-Za-z0-9]' AND
    idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 256 AND instr(id, char(0)) = 0),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9A-F]*'
  ),
  network TEXT NOT NULL CHECK (network = 'testnet'),
  rail TEXT NOT NULL CHECK (rail = 'xrpl-paychan'),
  merchant_id TEXT NOT NULL CHECK (
    length(merchant_id) BETWEEN 1 AND 128 AND
    substr(merchant_id, 1, 1) GLOB '[A-Za-z0-9]' AND
    merchant_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  sku TEXT NOT NULL CHECK (length(sku) BETWEEN 1 AND 200 AND instr(sku, char(0)) = 0),
  merchant_snapshot_json TEXT NOT NULL CHECK (
    length(merchant_snapshot_json) BETWEEN 2 AND 65536 AND json_valid(merchant_snapshot_json)
  ),
  payer TEXT NOT NULL CHECK (
    length(payer) BETWEEN 25 AND 64 AND substr(payer, 1, 1) = 'r' AND
    payer NOT GLOB '*[^A-Za-z0-9]*'
  ),
  channel_id TEXT NOT NULL CHECK (
    length(channel_id) = 64 AND channel_id NOT GLOB '*[^0-9A-F]*'
  ),
  channel_amount_drops TEXT NOT NULL CHECK (
    length(channel_amount_drops) BETWEEN 1 AND 18 AND
    channel_amount_drops NOT GLOB '*[^0-9]*' AND channel_amount_drops <> '0' AND
    substr(channel_amount_drops, 1, 1) <> '0' AND
    (length(channel_amount_drops) < 18 OR channel_amount_drops <= '100000000000000000')
  ),
  price_drops TEXT NOT NULL CHECK (
    length(price_drops) BETWEEN 1 AND 18 AND price_drops NOT GLOB '*[^0-9]*' AND
    price_drops <> '0' AND substr(price_drops, 1, 1) <> '0' AND
    (length(price_drops) < 18 OR price_drops <= '100000000000000000')
  ),
  previous_drops TEXT NOT NULL CHECK (
    length(previous_drops) BETWEEN 1 AND 18 AND previous_drops NOT GLOB '*[^0-9]*' AND
    (previous_drops = '0' OR substr(previous_drops, 1, 1) <> '0') AND
    (length(previous_drops) < 18 OR previous_drops <= '100000000000000000')
  ),
  cumulative_drops TEXT NOT NULL CHECK (
    length(cumulative_drops) BETWEEN 1 AND 18 AND cumulative_drops NOT GLOB '*[^0-9]*' AND
    cumulative_drops <> '0' AND substr(cumulative_drops, 1, 1) <> '0' AND
    (length(cumulative_drops) < 18 OR cumulative_drops <= '100000000000000000')
  ),
  claim_token TEXT NOT NULL CHECK (
    length(claim_token) = 64 AND claim_token NOT GLOB '*[^0-9A-F]*'
  ),
  public_key TEXT NOT NULL CHECK (
    length(public_key) = 66 AND substr(public_key, 1, 2) IN ('ED', '02', '03') AND
    public_key NOT GLOB '*[^0-9A-F]*'
  ),
  signature TEXT,
  spend_id TEXT NOT NULL,
  spend_day TEXT NOT NULL CHECK (length(spend_day) = 10),
  amount_usd TEXT NOT NULL CHECK (
    length(amount_usd) BETWEEN 1 AND 80 AND amount_usd NOT GLOB '*[^0-9.]*' AND
    substr(amount_usd, 1, 1) GLOB '[0-9]' AND substr(amount_usd, -1, 1) GLOB '[0-9]' AND
    amount_usd NOT LIKE '%.%.%' AND
    (amount_usd = '0' OR substr(amount_usd, 1, 1) <> '0' OR substr(amount_usd, 1, 2) = '0.') AND
    (instr(amount_usd, '.') = 0 OR
      length(amount_usd) - instr(amount_usd, '.') BETWEEN 1 AND 6)
  ),
  intent_id TEXT NOT NULL CHECK (length(intent_id) BETWEEN 1 AND 256 AND instr(intent_id, char(0)) = 0),
  l3a_digest TEXT NOT NULL CHECK (
    length(l3a_digest) = 64 AND l3a_digest NOT GLOB '*[^0-9a-f]*'
  ),
  l3b_digest TEXT NOT NULL CHECK (
    length(l3b_digest) = 64 AND l3b_digest NOT GLOB '*[^0-9a-f]*'
  ),
  retry_material_enc BLOB NOT NULL CHECK (length(retry_material_enc) > 16),
  retry_material_iv BLOB NOT NULL CHECK (length(retry_material_iv) = 12),
  retry_material_digest TEXT NOT NULL CHECK (
    length(retry_material_digest) = 64 AND retry_material_digest NOT GLOB '*[^0-9A-F]*'
  ),
  receipt_id TEXT NOT NULL CHECK (
    length(receipt_id) BETWEEN 1 AND 256 AND instr(receipt_id, char(0)) = 0
  ),
  merchant_response_json TEXT CHECK (
    merchant_response_json IS NULL OR
    (length(merchant_response_json) BETWEEN 2 AND 1048576 AND json_valid(merchant_response_json))
  ),
  result_json TEXT CHECK (
    result_json IS NULL OR (length(result_json) BETWEEN 2 AND 1048576 AND json_valid(result_json))
  ),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'claim_signed', 'merchant_accepted', 'delivered')),
  accepted_at TEXT CHECK (accepted_at IS NULL OR length(accepted_at) BETWEEN 20 AND 40),
  delivered_at TEXT CHECK (delivered_at IS NULL OR length(delivered_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (principal, mandate_id, idempotency_key),
  UNIQUE (principal, id),
  UNIQUE (principal, spend_id),
  UNIQUE (principal, receipt_id),
  FOREIGN KEY (mandate_id) REFERENCES ap4m_mandates(id),
  FOREIGN KEY (spend_id) REFERENCES ap4m_spend(id),
  FOREIGN KEY (principal, channel_id, idempotency_key)
    REFERENCES ap4m_channel_claim_attempts(principal, channel_id, idempotency_key),
  CHECK (
    CAST(previous_drops AS INTEGER) + CAST(price_drops AS INTEGER) =
      CAST(cumulative_drops AS INTEGER) AND
    CAST(cumulative_drops AS INTEGER) <= CAST(channel_amount_drops AS INTEGER)
  ),
  CHECK (
    (status = 'reserved' AND signature IS NULL AND
      merchant_response_json IS NULL AND result_json IS NULL AND
      accepted_at IS NULL AND delivered_at IS NULL)
    OR
    (status = 'claim_signed' AND signature IS NOT NULL AND
      merchant_response_json IS NULL AND result_json IS NULL AND
      accepted_at IS NULL AND delivered_at IS NULL)
    OR
    (status = 'merchant_accepted' AND signature IS NOT NULL AND
      merchant_response_json IS NOT NULL AND result_json IS NULL AND
      accepted_at IS NOT NULL AND delivered_at IS NULL)
    OR
    (status = 'delivered' AND signature IS NOT NULL AND
      merchant_response_json IS NOT NULL AND result_json IS NOT NULL AND
      accepted_at IS NOT NULL AND delivered_at IS NOT NULL)
  ),
  CHECK (
    signature IS NULL OR
    (length(signature) BETWEEN 2 AND 256 AND length(signature) % 2 = 0 AND
      signature NOT GLOB '*[^0-9A-F]*')
  )
) WITHOUT ROWID;

CREATE INDEX idx_ap4m_paychan_purchase_recovery
  ON ap4m_paychan_purchase_attempts(principal, status, updated_at);

CREATE INDEX idx_ap4m_paychan_purchase_channel
  ON ap4m_paychan_purchase_attempts(principal, channel_id, created_at);

CREATE TRIGGER trg_ap4m_channel_claim_mandate_insert
BEFORE INSERT ON ap4m_channel_claims
WHEN NOT EXISTS (
  SELECT 1 FROM ap4m_mandates mandate
  WHERE mandate.principal = NEW.principal AND mandate.id = NEW.mandate_id
    AND mandate.network = 'testnet'
)
BEGIN
  SELECT RAISE(ABORT, 'channel claim mandate binding mismatch');
END;

CREATE TRIGGER trg_ap4m_channel_claim_mandate_update
BEFORE UPDATE OF principal, mandate_id ON ap4m_channel_claims
WHEN NOT EXISTS (
  SELECT 1 FROM ap4m_mandates mandate
  WHERE mandate.principal = NEW.principal AND mandate.id = NEW.mandate_id
    AND mandate.network = 'testnet'
)
BEGIN
  SELECT RAISE(ABORT, 'channel claim mandate binding mismatch');
END;

CREATE TRIGGER trg_ap4m_channel_claim_binding_immutable
BEFORE UPDATE OF principal, mandate_id, merchant_id, channel_id, payer,
  channel_amount_drops, public_key
ON ap4m_channel_claims
WHEN OLD.principal <> NEW.principal OR OLD.mandate_id <> NEW.mandate_id
  OR OLD.merchant_id <> NEW.merchant_id OR OLD.channel_id <> NEW.channel_id
  OR OLD.payer <> NEW.payer OR OLD.channel_amount_drops <> NEW.channel_amount_drops
  OR OLD.public_key <> NEW.public_key
BEGIN
  SELECT RAISE(ABORT, 'channel claim binding mismatch');
END;

CREATE TRIGGER trg_ap4m_channel_attempt_binding_insert
BEFORE INSERT ON ap4m_channel_claim_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM ap4m_channel_claims claim
  WHERE claim.principal = NEW.principal AND claim.channel_id = NEW.channel_id
    AND claim.merchant_id = NEW.merchant_id AND claim.public_key = NEW.public_key
    AND claim.pending_idempotency_key = NEW.idempotency_key
    AND claim.pending_price_drops = NEW.price_drops
    AND claim.pending_cumulative_drops = NEW.cumulative_drops
    AND claim.pending_token = NEW.claim_token
)
BEGIN
  SELECT RAISE(ABORT, 'channel claim attempt binding mismatch');
END;

CREATE TRIGGER trg_ap4m_channel_attempt_binding_update
BEFORE UPDATE OF principal, channel_id, idempotency_key, merchant_id, price_drops,
  cumulative_drops, claim_token, public_key, signature, status
ON ap4m_channel_claim_attempts
WHEN NOT EXISTS (
  SELECT 1 FROM ap4m_channel_claims claim
  WHERE claim.principal = NEW.principal AND claim.channel_id = NEW.channel_id
    AND claim.merchant_id = NEW.merchant_id AND claim.public_key = NEW.public_key
    AND claim.pending_idempotency_key = NEW.idempotency_key
    AND claim.pending_price_drops = NEW.price_drops
    AND claim.pending_cumulative_drops = NEW.cumulative_drops
    AND claim.pending_token = NEW.claim_token
)
BEGIN
  SELECT RAISE(ABORT, 'channel claim attempt binding mismatch');
END;

CREATE TRIGGER trg_ap4m_paychan_purchase_binding_insert
BEFORE INSERT ON ap4m_paychan_purchase_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM ap4m_channel_claim_attempts attempt
  JOIN ap4m_channel_claims claim
    ON claim.principal = attempt.principal AND claim.channel_id = attempt.channel_id
  JOIN ap4m_mandates mandate
    ON mandate.principal = claim.principal AND mandate.id = claim.mandate_id
  JOIN ap4m_spend spend
    ON spend.principal = claim.principal AND spend.mandate_id = claim.mandate_id
      AND spend.id = NEW.spend_id
  WHERE attempt.principal = NEW.principal AND attempt.channel_id = NEW.channel_id
    AND attempt.idempotency_key = NEW.idempotency_key
    AND attempt.merchant_id = NEW.merchant_id AND attempt.price_drops = NEW.price_drops
    AND attempt.cumulative_drops = NEW.cumulative_drops
    AND attempt.claim_token = NEW.claim_token AND attempt.public_key = NEW.public_key
    AND claim.mandate_id = NEW.mandate_id AND claim.merchant_id = NEW.merchant_id
    AND claim.payer = NEW.payer AND claim.channel_amount_drops = NEW.channel_amount_drops
    AND claim.public_key = NEW.public_key AND mandate.network = 'testnet'
    AND spend.idempotency_key = NEW.idempotency_key AND spend.spend_day = NEW.spend_day
    AND spend.amount_usd = NEW.amount_usd AND spend.status = 'reserved'
    AND ((NEW.signature IS NULL AND attempt.status = 'pending' AND attempt.signature IS NULL
        AND claim.pending_idempotency_key = NEW.idempotency_key
        AND claim.pending_price_drops = NEW.price_drops
        AND claim.pending_cumulative_drops = NEW.cumulative_drops
        AND claim.pending_token = NEW.claim_token)
      OR (NEW.signature IS NOT NULL AND attempt.status = 'completed'
        AND attempt.signature = NEW.signature
        AND claim.last_idempotency_key = NEW.idempotency_key
        AND claim.last_price_drops = NEW.price_drops
        AND claim.cumulative_drops = NEW.cumulative_drops
        AND claim.signature = NEW.signature))
)
BEGIN
  SELECT RAISE(ABORT, 'paychan purchase claim binding mismatch');
END;

CREATE TRIGGER trg_ap4m_paychan_purchase_binding_update
BEFORE UPDATE OF principal, mandate_id, idempotency_key, merchant_id, payer, channel_id,
  channel_amount_drops, price_drops, cumulative_drops, claim_token, public_key, signature,
  spend_id, spend_day, amount_usd
ON ap4m_paychan_purchase_attempts
WHEN NOT EXISTS (
  SELECT 1
  FROM ap4m_channel_claim_attempts attempt
  JOIN ap4m_channel_claims claim
    ON claim.principal = attempt.principal AND claim.channel_id = attempt.channel_id
  JOIN ap4m_mandates mandate
    ON mandate.principal = claim.principal AND mandate.id = claim.mandate_id
  JOIN ap4m_spend spend
    ON spend.principal = claim.principal AND spend.mandate_id = claim.mandate_id
      AND spend.id = NEW.spend_id
  WHERE attempt.principal = NEW.principal AND attempt.channel_id = NEW.channel_id
    AND attempt.idempotency_key = NEW.idempotency_key
    AND attempt.merchant_id = NEW.merchant_id AND attempt.price_drops = NEW.price_drops
    AND attempt.cumulative_drops = NEW.cumulative_drops
    AND attempt.claim_token = NEW.claim_token AND attempt.public_key = NEW.public_key
    AND claim.mandate_id = NEW.mandate_id AND claim.merchant_id = NEW.merchant_id
    AND claim.payer = NEW.payer AND claim.channel_amount_drops = NEW.channel_amount_drops
    AND claim.public_key = NEW.public_key AND mandate.network = 'testnet'
    AND spend.idempotency_key = NEW.idempotency_key AND spend.spend_day = NEW.spend_day
    AND spend.amount_usd = NEW.amount_usd AND spend.status = 'reserved'
    AND ((NEW.signature IS NULL AND attempt.status = 'pending' AND attempt.signature IS NULL
        AND claim.pending_idempotency_key = NEW.idempotency_key
        AND claim.pending_price_drops = NEW.price_drops
        AND claim.pending_cumulative_drops = NEW.cumulative_drops
        AND claim.pending_token = NEW.claim_token)
      OR (NEW.signature IS NOT NULL AND attempt.status = 'completed'
        AND attempt.signature = NEW.signature
        AND claim.last_idempotency_key = NEW.idempotency_key
        AND claim.last_price_drops = NEW.price_drops
        AND claim.cumulative_drops = NEW.cumulative_drops
        AND claim.signature = NEW.signature))
)
BEGIN
  SELECT RAISE(ABORT, 'paychan purchase claim binding mismatch');
END;

CREATE TRIGGER trg_ap4m_paychan_receipt_binding_insert
BEFORE INSERT ON ap4m_receipts
WHEN EXISTS (
  SELECT 1 FROM ap4m_paychan_purchase_attempts purchase
  WHERE purchase.principal = NEW.principal AND purchase.mandate_id = NEW.mandate_id
    AND purchase.idempotency_key = NEW.idempotency_key
) AND NOT EXISTS (
  SELECT 1
  FROM ap4m_paychan_purchase_attempts purchase
  JOIN ap4m_spend spend ON spend.id = purchase.spend_id
  WHERE purchase.principal = NEW.principal AND purchase.mandate_id = NEW.mandate_id
    AND purchase.idempotency_key = NEW.idempotency_key
    AND purchase.status = 'merchant_accepted' AND purchase.merchant_response_json IS NOT NULL
    AND purchase.receipt_id = NEW.id AND purchase.merchant_id = NEW.merchant_id
    AND spend.principal = purchase.principal AND spend.mandate_id = purchase.mandate_id
    AND spend.idempotency_key = purchase.idempotency_key AND spend.spend_day = purchase.spend_day
    AND spend.amount_usd = purchase.amount_usd AND spend.status = 'reserved'
    AND spend.receipt_id IS NULL
    AND json_valid(NEW.json) AND json_type(NEW.json) = 'object'
    AND json_extract(NEW.json, '$.receipt_id') = purchase.receipt_id
    AND json_extract(NEW.json, '$.mandate_id') = purchase.mandate_id
    AND json_extract(NEW.json, '$.merchant_id') = purchase.merchant_id
    AND json_extract(NEW.json, '$.sku') = purchase.sku
    AND json_extract(NEW.json, '$.intent_id') = purchase.intent_id
    AND json_extract(NEW.json, '$.l3a_digest') = purchase.l3a_digest
    AND json_extract(NEW.json, '$.l3b_digest') = purchase.l3b_digest
    AND json_extract(NEW.json, '$.scheme') = 'xrpl-paychan'
    AND json_extract(NEW.json, '$.settlement') = 'claim_accepted'
    AND json_extract(NEW.json, '$.proof.channel_id') = purchase.channel_id
    AND json_extract(NEW.json, '$.proof.cumulative_drops') = purchase.cumulative_drops
    AND json_extract(NEW.json, '$.amount.value') = purchase.amount_usd
)
BEGIN
  SELECT RAISE(ABORT, 'paychan receipt binding mismatch');
END;

CREATE TRIGGER trg_ap4m_paychan_delivered_update
BEFORE UPDATE OF status, result_json, delivered_at ON ap4m_paychan_purchase_attempts
WHEN NEW.status = 'delivered' AND OLD.status <> 'delivered' AND NOT EXISTS (
  SELECT 1
  FROM ap4m_spend spend
  JOIN ap4m_receipts receipt ON receipt.id = NEW.receipt_id
  WHERE spend.id = NEW.spend_id AND spend.principal = NEW.principal
    AND spend.mandate_id = NEW.mandate_id AND spend.idempotency_key = NEW.idempotency_key
    AND spend.spend_day = NEW.spend_day AND spend.amount_usd = NEW.amount_usd
    AND spend.status = 'committed' AND spend.receipt_id = NEW.receipt_id
    AND receipt.principal = NEW.principal AND receipt.mandate_id = NEW.mandate_id
    AND receipt.merchant_id = NEW.merchant_id AND receipt.idempotency_key = NEW.idempotency_key
    AND json_valid(receipt.json) AND json_valid(NEW.result_json)
    AND json_type(NEW.result_json) = 'object'
    AND json(json_extract(NEW.result_json, '$.receipt')) = json(receipt.json)
)
BEGIN
  SELECT RAISE(ABORT, 'paychan delivered binding mismatch');
END;

CREATE TRIGGER trg_ap4m_exact_excludes_paychan_insert
BEFORE INSERT ON ap4m_purchase_attempts
WHEN EXISTS (
  SELECT 1 FROM ap4m_paychan_purchase_attempts paychan
  WHERE paychan.principal = NEW.principal AND paychan.mandate_id = NEW.mandate_id
    AND paychan.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency key already belongs to paychan rail');
END;

CREATE TRIGGER trg_ap4m_paychan_excludes_exact_insert
BEFORE INSERT ON ap4m_paychan_purchase_attempts
WHEN EXISTS (
  SELECT 1 FROM ap4m_purchase_attempts exact
  WHERE exact.principal = NEW.principal AND exact.mandate_id = NEW.mandate_id
    AND exact.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency key already belongs to exact rail');
END;

CREATE TRIGGER trg_ap4m_exact_excludes_paychan_update
BEFORE UPDATE OF principal, mandate_id, idempotency_key ON ap4m_purchase_attempts
WHEN EXISTS (
  SELECT 1 FROM ap4m_paychan_purchase_attempts paychan
  WHERE paychan.principal = NEW.principal AND paychan.mandate_id = NEW.mandate_id
    AND paychan.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency key already belongs to paychan rail');
END;

CREATE TRIGGER trg_ap4m_paychan_excludes_exact_update
BEFORE UPDATE OF principal, mandate_id, idempotency_key ON ap4m_paychan_purchase_attempts
WHEN EXISTS (
  SELECT 1 FROM ap4m_purchase_attempts exact
  WHERE exact.principal = NEW.principal AND exact.mandate_id = NEW.mandate_id
    AND exact.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency key already belongs to exact rail');
END;

CREATE TABLE payer_sequence_leases (
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  payer TEXT NOT NULL CHECK (length(payer) BETWEEN 25 AND 64),
  generation INTEGER NOT NULL CHECK (generation > 0),
  lease_token TEXT NOT NULL CHECK (
    length(lease_token) = 64 AND lease_token NOT GLOB '*[^0-9A-F]*'
  ),
  rail TEXT NOT NULL CHECK (rail IN ('ap4m', 'x402', 'legacy')),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 256),
  state TEXT NOT NULL CHECK (state IN (
    'preparing', 'signing', 'signed', 'settlement_unknown',
    'legacy_ambiguous', 'released'
  )),
  sequence INTEGER CHECK (sequence IS NULL OR sequence BETWEEN 0 AND 4294967295),
  first_eligible_ledger_index INTEGER CHECK (
    first_eligible_ledger_index IS NULL OR first_eligible_ledger_index > 0
  ),
  last_ledger_sequence INTEGER CHECK (
    last_ledger_sequence IS NULL OR last_ledger_sequence > 0
  ),
  tx_hash TEXT CHECK (
    tx_hash IS NULL OR
    (length(tx_hash) = 64 AND tx_hash NOT GLOB '*[^0-9A-F]*')
  ),
  acquired_at TEXT NOT NULL,
  signing_started_at TEXT,
  signed_at TEXT,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT CHECK (
    release_reason IS NULL OR
    release_reason IN ('pre_sign', 'validated_terminal', 'expired_absent')
  ),
  resolution_ledger_index INTEGER CHECK (
    resolution_ledger_index IS NULL OR resolution_ledger_index > 0
  ),
  PRIMARY KEY (network, payer),
  CHECK (
    first_eligible_ledger_index IS NULL OR last_ledger_sequence IS NULL OR
    first_eligible_ledger_index <= last_ledger_sequence
  ),
  CHECK (
    (state = 'preparing' AND sequence IS NULL AND first_eligible_ledger_index IS NULL
      AND last_ledger_sequence IS NULL AND tx_hash IS NULL
      AND signing_started_at IS NULL AND signed_at IS NULL
      AND released_at IS NULL AND release_reason IS NULL
      AND resolution_ledger_index IS NULL)
    OR
    (state = 'signing' AND sequence IS NOT NULL
      AND first_eligible_ledger_index IS NOT NULL AND last_ledger_sequence IS NOT NULL
      AND tx_hash IS NULL AND signing_started_at IS NOT NULL
      AND signed_at IS NULL AND released_at IS NULL
      AND release_reason IS NULL AND resolution_ledger_index IS NULL)
    OR
    (state IN ('signed', 'settlement_unknown') AND sequence IS NOT NULL
      AND first_eligible_ledger_index IS NOT NULL AND last_ledger_sequence IS NOT NULL
      AND tx_hash IS NOT NULL AND signing_started_at IS NOT NULL
      AND signed_at IS NOT NULL AND released_at IS NULL
      AND release_reason IS NULL AND resolution_ledger_index IS NULL)
    OR
    (state = 'legacy_ambiguous' AND rail = 'legacy'
      AND released_at IS NULL AND release_reason IS NULL
      AND resolution_ledger_index IS NULL)
    OR
    (state = 'released' AND rail IN ('ap4m', 'x402')
      AND released_at IS NOT NULL AND release_reason IS NOT NULL
      AND ((release_reason = 'pre_sign' AND signing_started_at IS NULL
        AND tx_hash IS NULL AND resolution_ledger_index IS NULL)
      OR (release_reason IN ('validated_terminal', 'expired_absent')
        AND tx_hash IS NOT NULL AND resolution_ledger_index IS NOT NULL)))
  )
);

-- Any pre-existing nonterminal x402 payment is ambiguous at the migration
-- boundary. Fence its payer permanently until its durable payment row is
-- reconciled by an explicit compatibility procedure; elapsed time is never
-- evidence that signing or submission did not happen.
INSERT INTO payer_sequence_leases (
  network, payer, generation, lease_token, rail, attempt_id, state,
  sequence, first_eligible_ledger_index, last_ledger_sequence, tx_hash,
  acquired_at, signing_started_at, signed_at, updated_at
)
SELECT
  network,
  delegate,
  1,
  upper(hex(randomblob(32))),
  'legacy',
  'legacy-x402:' || min(id),
  'legacy_ambiguous',
  NULL,
  NULL,
  max(last_ledger_seq),
  NULL,
  min(COALESCE(lease_acquired_at, created_at)),
  min(signing_started_at),
  min(signed_at),
  max(updated_at)
FROM x402_payments
WHERE status NOT IN ('failed', 'delivered')
GROUP BY network, delegate;

CREATE INDEX idx_payer_sequence_leases_active_attempt
  ON payer_sequence_leases(rail, attempt_id, state);

-- Global sequence lock shared with Harbor's ordinary/manual and autonomous
-- execution paths. Principal identifies the winning authority for audit only;
-- it intentionally does not partition the ledger-account lock.
CREATE TABLE account_sequence_leases (
  principal TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  account TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  lease_token TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('strategy', 'manual', 'ap4m', 'x402')),
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'preparing', 'signing', 'signed', 'submitted', 'ambiguous', 'released'
  )),
  sequence INTEGER,
  first_ledger_sequence INTEGER,
  last_ledger_sequence INTEGER,
  tx_hash TEXT,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  release_evidence TEXT,
  PRIMARY KEY (network, account),
  UNIQUE (network, account, generation),
  UNIQUE (network, account, source, attempt_id)
);

INSERT INTO account_sequence_leases (
  principal, network, account, generation, lease_token, source, attempt_id,
  state, sequence, first_ledger_sequence, last_ledger_sequence, tx_hash,
  acquired_at, updated_at
)
SELECT
  'legacy:payer-runtime', network, payer, generation, lease_token,
  CASE WHEN rail = 'ap4m' THEN 'ap4m' ELSE 'x402' END,
  attempt_id, 'ambiguous', sequence, first_eligible_ledger_index,
  last_ledger_sequence, tx_hash, acquired_at, updated_at
FROM payer_sequence_leases
WHERE state <> 'released';

CREATE INDEX idx_account_sequence_leases_state
  ON account_sequence_leases(network, account, state);
