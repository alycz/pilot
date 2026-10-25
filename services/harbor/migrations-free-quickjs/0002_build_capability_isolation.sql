ALTER TABLE builds ADD COLUMN origin_profile TEXT;

CREATE TABLE build_consumptions (
  principal TEXT NOT NULL,
  build_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('claimed', 'consumed')),
  claimed_at TEXT NOT NULL,
  consumed_at TEXT,
  PRIMARY KEY (principal, build_id),
  CHECK (
    (status = 'claimed' AND consumed_at IS NULL) OR
    (status = 'consumed' AND consumed_at IS NOT NULL)
  )
);

CREATE TABLE direct_submission_bindings (
  principal TEXT NOT NULL,
  hash TEXT NOT NULL,
  owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  origin_profile TEXT CHECK (
    origin_profile IS NULL OR
    origin_profile IN ('local-trading', 'local-trading-onboarding')
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal, hash)
);

CREATE TRIGGER consume_onboarding_build_after_execution_terminal
AFTER UPDATE OF status ON executions
WHEN NEW.status IN ('executed', 'needs_approval', 'blocked', 'failed')
BEGIN
  UPDATE build_consumptions
     SET status = 'consumed',
         consumed_at = COALESCE(consumed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
   WHERE principal = NEW.principal
     AND build_id = NEW.build_id
     AND idempotency_key = NEW.idempotency_key
     AND status = 'claimed';
END;
