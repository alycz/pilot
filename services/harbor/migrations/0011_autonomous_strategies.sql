-- Durable, fail-closed state for the testnet-only deterministic rebalancer.
-- Owner authorization is a versioned immutable mandate; delegate/owner key
-- material is never stored in these tables.

CREATE TABLE strategy_global_controls (
  principal TEXT NOT NULL,
  owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'testnet'),
  kill_enabled INTEGER NOT NULL DEFAULT 1 CHECK (kill_enabled IN (0, 1)),
  kill_reason TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (principal, owner, network)
);

CREATE TABLE strategy_mandates (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  digest TEXT NOT NULL CHECK (length(digest) = 64),
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'revoked', 'expired')),
  kind TEXT NOT NULL CHECK (kind = 'xrp_issued_rebalancer_v1'),
  network TEXT NOT NULL CHECK (network = 'testnet'),
  owner TEXT NOT NULL,
  issued_currency TEXT NOT NULL,
  issued_issuer TEXT NOT NULL,
  config_json TEXT NOT NULL,
  authorization_id TEXT,
  authorization_method TEXT CHECK (
    authorization_method IS NULL OR authorization_method = 'wallet_action_proof_v1'
  ),
  approved_at TEXT,
  not_before TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (status = 'approved' AND authorization_id IS NOT NULL AND approved_at IS NOT NULL)
    OR status <> 'approved'
  ),
  UNIQUE (principal, strategy_id, version),
  UNIQUE (principal, digest)
);

CREATE TABLE strategies (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'testnet'),
  issued_currency TEXT NOT NULL,
  issued_issuer TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('draft', 'paused', 'active', 'stopped', 'error')),
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL CHECK (mandate_version > 0),
  mandate_digest TEXT NOT NULL CHECK (length(mandate_digest) = 64),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  next_evaluation_at TEXT,
  last_evaluation_at TEXT,
  last_trade_at TEXT,
  hold_reason TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (mandate_id) REFERENCES strategy_mandates(id),
  UNIQUE (principal, owner, network),
  UNIQUE (principal, id)
);

CREATE TABLE strategy_schedules (
  strategy_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 300 AND 86400),
  next_evaluation_at TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  generation INTEGER NOT NULL CHECK (generation >= 0),
  updated_at TEXT NOT NULL,
  FOREIGN KEY (strategy_id) REFERENCES strategies(id)
);

CREATE TABLE strategy_leases (
  strategy_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  holder_id TEXT NOT NULL,
  lease_token TEXT NOT NULL UNIQUE,
  fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
  acquired_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (strategy_id) REFERENCES strategies(id)
);

-- Shared with manual/x402 submission paths. A signed/submitted/ambiguous row is
-- never reclaimed by elapsed wall time; reconciliation must release it using
-- ledger evidence. This prevents sequence reuse across independent workers.
CREATE TABLE account_sequence_leases (
  principal TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet', 'lending-devnet')),
  account TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  lease_token TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('strategy', 'manual', 'ap4m', 'x402')),
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'preparing', 'signing', 'signed', 'submitted', 'ambiguous', 'released'
  )),
  sequence INTEGER CHECK (sequence >= 0),
  first_ledger_sequence INTEGER CHECK (first_ledger_sequence > 0),
  last_ledger_sequence INTEGER CHECK (last_ledger_sequence > 0),
  tx_hash TEXT,
  acquired_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  release_evidence TEXT,
  -- Ledger sequence uniqueness is global to an XRPL account. Principal is
  -- authorization/audit metadata and must never partition this lock.
  PRIMARY KEY (network, account),
  UNIQUE (network, account, generation),
  UNIQUE (network, account, source, attempt_id),
  CHECK (
    state NOT IN ('signed', 'submitted', 'ambiguous') OR sequence IS NOT NULL
  )
);

CREATE TABLE strategy_triggers (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  schedule_generation INTEGER NOT NULL CHECK (schedule_generation >= 0),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'blocked', 'failed')),
  lease_fencing_token INTEGER,
  decision_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  UNIQUE (principal, strategy_id, schedule_generation, scheduled_for)
);

CREATE TABLE strategy_decisions (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL UNIQUE,
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL CHECK (mandate_version > 0),
  mandate_digest TEXT NOT NULL CHECK (length(mandate_digest) = 64),
  action TEXT NOT NULL CHECK (action IN ('hold', 'buy_xrp', 'sell_xrp')),
  hold_codes_json TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  quote_json TEXT,
  proposed_value TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'held', 'planned', 'reserved', 'building', 'needs_approval',
    'submitting', 'pending_reconciliation', 'executed', 'failed'
  )),
  explanation TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  FOREIGN KEY (trigger_id) REFERENCES strategy_triggers(id),
  FOREIGN KEY (mandate_id) REFERENCES strategy_mandates(id)
);

CREATE TABLE strategy_budget_reservations (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  decision_id TEXT NOT NULL UNIQUE,
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL CHECK (mandate_version > 0),
  order_value TEXT NOT NULL,
  -- Conservative fixed-point budget accounting. The runner rounds proposed
  -- values up to millionths before reserving, so concurrent workers can use
  -- one atomic INTEGER SUM without SQLite REAL precision loss.
  order_value_microunits INTEGER NOT NULL CHECK (
    order_value_microunits > 0 AND order_value_microunits <= 9000000000000000
  ),
  fee_drops TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released', 'unknown')),
  execution_id TEXT,
  reserved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  release_evidence TEXT,
  FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  FOREIGN KEY (decision_id) REFERENCES strategy_decisions(id),
  FOREIGN KEY (mandate_id) REFERENCES strategy_mandates(id)
);

CREATE TABLE strategy_executions (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  decision_id TEXT NOT NULL UNIQUE,
  build_id TEXT,
  harbor_execution_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  tx_hash TEXT,
  submission_state TEXT NOT NULL CHECK (submission_state IN (
    'prepared', 'submitting', 'unknown', 'submitted', 'validated',
    'not_included', 'needs_approval', 'failed'
  )),
  unresolved INTEGER NOT NULL DEFAULT 1 CHECK (unresolved IN (0, 1)),
  last_ledger_sequence INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_evidence TEXT,
  FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  FOREIGN KEY (decision_id) REFERENCES strategy_decisions(id)
);

CREATE TABLE strategy_audit_events (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  strategy_id TEXT,
  trigger_id TEXT,
  decision_id TEXT,
  execution_id TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('owner', 'scheduler', 'runner', 'reconciler', 'system')),
  kind TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Every owner control is bound to one stable request and exact payload digest.
-- Unknown HTTP outcomes can replay this receipt without applying a second
-- lifecycle transition or silently changing the requested action.
CREATE TABLE strategy_control_receipts (
  principal TEXT NOT NULL,
  request_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  strategy_id TEXT,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal, request_id)
);

CREATE INDEX idx_strategy_schedule_due
  ON strategy_schedules(enabled, next_evaluation_at);
CREATE INDEX idx_strategy_mandate_current
  ON strategy_mandates(principal, strategy_id, status, version);
CREATE INDEX idx_strategy_trigger_status
  ON strategy_triggers(principal, strategy_id, status, scheduled_for);
CREATE INDEX idx_strategy_budget_day
  ON strategy_budget_reservations(principal, strategy_id, state, reserved_at);
CREATE INDEX idx_strategy_execution_unresolved
  ON strategy_executions(principal, strategy_id, unresolved, updated_at);
CREATE INDEX idx_account_sequence_state
  ON account_sequence_leases(network, account, state);
CREATE INDEX idx_strategy_audit
  ON strategy_audit_events(principal, strategy_id, created_at);
