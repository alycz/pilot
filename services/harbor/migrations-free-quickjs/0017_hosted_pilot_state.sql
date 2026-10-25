-- Private Pilot-to-Harbor hosted state. These tables are inert unless the
-- separately authenticated internal route is enabled for one exact principal.
-- Only opaque scope digests, nonce digests, encrypted personalization state,
-- and bounded quota accounting are stored; raw wallet/session data is absent.

CREATE TABLE pilot_hosted_state_clock (
  principal TEXT PRIMARY KEY CHECK (length(principal) BETWEEN 1 AND 128),
  observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0)
);

CREATE TABLE pilot_wallet_proof_consumptions (
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
  namespace TEXT NOT NULL CHECK (namespace IN ('chat', 'wallet-auth')),
  scope_id TEXT NOT NULL CHECK (
    length(scope_id) = 64 AND scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  nonce_digest TEXT NOT NULL CHECK (
    length(nonce_digest) = 64 AND nonce_digest NOT GLOB '*[^0-9a-f]*'
  ),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (principal, namespace, scope_id, nonce_digest)
);

CREATE INDEX idx_pilot_wallet_proof_expiry
  ON pilot_wallet_proof_consumptions(principal, expires_at_ms);

-- Rows persist only until an authenticated exact-digest delete; deletion is
-- physical and creates no recoverable tombstone.
CREATE TABLE pilot_personalization_state (
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
  scope_id TEXT NOT NULL CHECK (
    length(scope_id) = 64 AND scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  resource TEXT NOT NULL CHECK (resource IN ('preferences', 'workflow-lessons')),
  content_digest TEXT NOT NULL CHECK (
    length(content_digest) = 64 AND content_digest NOT GLOB '*[^0-9a-f]*'
  ),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 1 AND 1398358),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY (principal, scope_id, resource)
);
CREATE TRIGGER cap_pilot_personalization_state
BEFORE INSERT ON pilot_personalization_state
WHEN NOT EXISTS (
  SELECT 1 FROM pilot_personalization_state
  WHERE principal = NEW.principal AND scope_id = NEW.scope_id AND resource = NEW.resource
) AND (
  SELECT COUNT(*) FROM pilot_personalization_state WHERE principal = NEW.principal
) >= 4096
BEGIN
  SELECT RAISE(ABORT, 'pilot personalization capacity reached');
END;

CREATE TABLE pilot_research_quota_policy (
  principal TEXT PRIMARY KEY CHECK (length(principal) BETWEEN 1 AND 128),
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 64),
  account_maximum INTEGER NOT NULL CHECK (account_maximum BETWEEN 1 AND 24),
  session_maximum INTEGER NOT NULL CHECK (
    session_maximum BETWEEN 1 AND 12 AND session_maximum <= account_maximum
  ),
  window_ms INTEGER NOT NULL CHECK (window_ms = 3600000),
  retention_ms INTEGER NOT NULL CHECK (retention_ms = 7200000),
  max_active_reservations INTEGER NOT NULL CHECK (max_active_reservations = 4096)
);

CREATE TABLE pilot_research_quota_session_bindings (
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
  session_scope_id TEXT NOT NULL CHECK (
    length(session_scope_id) = 64 AND session_scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  account_scope_id TEXT NOT NULL CHECK (
    length(account_scope_id) = 64 AND account_scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  session_expires_at_ms INTEGER NOT NULL CHECK (session_expires_at_ms > 0),
  PRIMARY KEY (principal, session_scope_id)
);
CREATE TRIGGER cap_pilot_research_quota_session_bindings
BEFORE INSERT ON pilot_research_quota_session_bindings
WHEN NOT EXISTS (
  SELECT 1 FROM pilot_research_quota_session_bindings
  WHERE principal = NEW.principal AND session_scope_id = NEW.session_scope_id
) AND (
  SELECT COUNT(*) FROM pilot_research_quota_session_bindings WHERE principal = NEW.principal
) >= 4096
BEGIN
  SELECT RAISE(ABORT, 'pilot research session-binding capacity reached');
END;

CREATE TABLE pilot_research_quota_reservations (
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
  request_id TEXT NOT NULL CHECK (length(request_id) = 36),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'
  ),
  account_scope_id TEXT NOT NULL CHECK (
    length(account_scope_id) = 64 AND account_scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  session_scope_id TEXT NOT NULL CHECK (
    length(session_scope_id) = 64 AND session_scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  window_start_ms INTEGER NOT NULL CHECK (window_start_ms >= 0),
  window_expires_at_ms INTEGER NOT NULL CHECK (window_expires_at_ms > window_start_ms),
  retain_until_ms INTEGER NOT NULL CHECK (retain_until_ms > window_expires_at_ms),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= window_start_ms),
  remaining_account_runs INTEGER NOT NULL CHECK (remaining_account_runs >= 0),
  remaining_session_runs INTEGER NOT NULL CHECK (remaining_session_runs >= 0),
  PRIMARY KEY (principal, request_id),
  FOREIGN KEY (principal, session_scope_id)
    REFERENCES pilot_research_quota_session_bindings(principal, session_scope_id)
);

CREATE INDEX idx_pilot_research_quota_account_window
  ON pilot_research_quota_reservations(principal, account_scope_id, window_start_ms);
CREATE INDEX idx_pilot_research_quota_session_window
  ON pilot_research_quota_reservations(principal, session_scope_id, window_start_ms);
CREATE INDEX idx_pilot_research_quota_retention
  ON pilot_research_quota_reservations(principal, retain_until_ms);
