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
