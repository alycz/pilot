-- Dedicated replay-consumption state for NEAR wallet authorization. Keeping a
-- separate table preserves the already-applied 0017 chat/wallet-auth schema and
-- makes the domain separation structural rather than caller-selected.

CREATE TABLE pilot_near_wallet_proof_consumptions (
  principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 128),
  scope_id TEXT NOT NULL CHECK (
    length(scope_id) = 64 AND scope_id NOT GLOB '*[^0-9a-f]*'
  ),
  nonce_digest TEXT NOT NULL CHECK (
    length(nonce_digest) = 64 AND nonce_digest NOT GLOB '*[^0-9a-f]*'
  ),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  PRIMARY KEY (principal, scope_id, nonce_digest)
);

CREATE INDEX idx_pilot_near_wallet_proof_expiry
  ON pilot_near_wallet_proof_consumptions(principal, expires_at_ms);
