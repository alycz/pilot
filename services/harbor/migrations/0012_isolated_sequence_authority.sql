-- Forward-compatible account sequence authority for isolated runtime profiles.
-- Canonical databases already receive this exact table from migration 0011;
-- IF NOT EXISTS makes this migration an idempotent no-op there.
CREATE TABLE IF NOT EXISTS account_sequence_leases (
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
  -- Principal is authorization/audit metadata. Ledger sequence ownership is
  -- account-global, including across manual and autonomous producers.
  PRIMARY KEY (network, account),
  UNIQUE (network, account, generation),
  UNIQUE (network, account, source, attempt_id),
  CHECK (
    state NOT IN ('signed', 'submitted', 'ambiguous') OR sequence IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_account_sequence_state
  ON account_sequence_leases(network, account, state);
