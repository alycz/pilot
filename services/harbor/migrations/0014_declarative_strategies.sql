-- Additive persistence for reviewed declarative strategy plans and their
-- aggregate risk reservations. Existing v1 rebalancer tables and rows remain
-- byte-for-byte and behaviorally unchanged.

CREATE TABLE strategy_declarative_plans (
  mandate_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL CHECK (mandate_version > 0),
  plan_version TEXT NOT NULL CHECK (plan_version = '1'),
  plan_digest TEXT NOT NULL CHECK (
    length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9A-F]*'
  ),
  plan_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (principal, strategy_id, mandate_version),
  UNIQUE (principal, plan_digest)
);

-- Declarative reservations are separate from the frozen v1 reservation shape
-- so fee and cumulative-count accounting can be atomic without rewriting the
-- historical migration. A decision belongs to exactly one reservation track.
CREATE TABLE strategy_declarative_reservations (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  decision_id TEXT NOT NULL UNIQUE,
  mandate_id TEXT NOT NULL,
  mandate_version INTEGER NOT NULL CHECK (mandate_version > 0),
  owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network = 'testnet'),
  issued_currency TEXT NOT NULL,
  issued_issuer TEXT NOT NULL,
  authority_not_before TEXT NOT NULL,
  authority_expires_at TEXT NOT NULL,
  order_value TEXT NOT NULL,
  order_value_microunits INTEGER NOT NULL CHECK (
    order_value_microunits > 0 AND order_value_microunits <= 9000000000000000
  ),
  fee_drops INTEGER NOT NULL CHECK (
    fee_drops >= 0 AND fee_drops <= 9000000000000000
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released', 'unknown')),
  execution_id TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  released_at TEXT,
  release_evidence TEXT,
  UNIQUE (principal, strategy_id, decision_id)
);

CREATE INDEX idx_strategy_declarative_plan
  ON strategy_declarative_plans(principal, strategy_id, mandate_version);
CREATE INDEX idx_strategy_declarative_budget_day
  ON strategy_declarative_reservations(principal, strategy_id, state, reserved_at);
CREATE INDEX idx_strategy_declarative_mandate_usage
  ON strategy_declarative_reservations(principal, mandate_id, state);
CREATE INDEX idx_strategy_declarative_authority_usage
  ON strategy_declarative_reservations(
    owner, network, issued_currency, issued_issuer, state, reserved_at
  );
CREATE INDEX idx_strategy_declarative_execution
  ON strategy_declarative_reservations(principal, execution_id, state);
