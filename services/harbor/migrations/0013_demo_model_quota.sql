-- Shared, zero-paid model-demo quota state. This migration is additive and
-- deliberately excluded from the frozen local trading and x402 profiles.
-- Wallet and browser-session identities are domain-separated HMAC digests;
-- model credentials, prompts, responses, and raw wallet identities never enter D1.

CREATE TABLE demo_model_quota_reservations (
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
  id TEXT NOT NULL CHECK (length(id) = 36),
  request_id TEXT NOT NULL CHECK (
    length(request_id) = 64 AND request_id NOT GLOB '*[^0-9a-f]*'
  ),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  wallet_scope_id TEXT NOT NULL CHECK (
    length(wallet_scope_id) = 64 AND wallet_scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  session_scope_id TEXT NOT NULL CHECK (
    length(session_scope_id) = 64 AND session_scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  model TEXT NOT NULL CHECK (
    length(model) BETWEEN 1 AND 206 AND instr(model, '/') > 1 AND substr(model, -5) = ':free'
  ),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  utc_day TEXT NOT NULL CHECK (length(utc_day) = 10),
  reserved_output_tokens INTEGER NOT NULL CHECK (reserved_output_tokens > 0),
  max_output_tokens_per_step INTEGER NOT NULL CHECK (max_output_tokens_per_step > 0),
  max_steps INTEGER NOT NULL CHECK (max_steps > 0),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
  remaining_global_daily_output_tokens INTEGER NOT NULL CHECK (
    remaining_global_daily_output_tokens >= 0
  ),
  remaining_wallet_daily_output_tokens INTEGER NOT NULL CHECK (
    remaining_wallet_daily_output_tokens >= 0
  ),
  remaining_wallet_daily_requests INTEGER NOT NULL CHECK (
    remaining_wallet_daily_requests >= 0
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'uncertain')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  settled_at_ms INTEGER CHECK (settled_at_ms IS NULL OR settled_at_ms >= 0),
  actual_input_tokens INTEGER CHECK (
    actual_input_tokens IS NULL OR actual_input_tokens >= 0
  ),
  actual_output_tokens INTEGER CHECK (
    actual_output_tokens IS NULL OR actual_output_tokens >= 0
  ),
  PRIMARY KEY (principal, id),
  UNIQUE (principal, request_id),
  CHECK (
    (status = 'active' AND settled_at_ms IS NULL)
    OR (status IN ('completed', 'uncertain') AND settled_at_ms IS NOT NULL)
  )
);

CREATE TABLE demo_model_zero_cost_integrity (
  principal TEXT PRIMARY KEY CHECK (length(principal) BETWEEN 1 AND 128),
  tripped_at_ms INTEGER NOT NULL CHECK (tripped_at_ms >= 0),
  failure TEXT NOT NULL CHECK (
    failure IN (
      'unexpected-model', 'missing-cost', 'nonzero-cost', 'unverified-cost'
    )
  )
);

CREATE INDEX idx_demo_model_quota_principal_day
  ON demo_model_quota_reservations(principal, utc_day);
CREATE INDEX idx_demo_model_quota_wallet_day
  ON demo_model_quota_reservations(principal, wallet_scope_id, utc_day);
CREATE INDEX idx_demo_model_quota_session_day
  ON demo_model_quota_reservations(principal, session_scope_id, utc_day);
CREATE INDEX idx_demo_model_quota_session_rate
  ON demo_model_quota_reservations(principal, session_scope_id, created_at_ms);
CREATE INDEX idx_demo_model_quota_active_expiry
  ON demo_model_quota_reservations(principal, status, expires_at_ms);
