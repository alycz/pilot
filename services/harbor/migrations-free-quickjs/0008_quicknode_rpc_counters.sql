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
