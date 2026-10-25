ALTER TABLE direct_submission_bindings
  RENAME TO direct_submission_bindings_before_isolated_onboarding_v1;

CREATE TABLE direct_submission_bindings (
  principal TEXT NOT NULL,
  hash TEXT NOT NULL,
  owner TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  origin_profile TEXT CHECK (
    origin_profile IS NULL OR
    origin_profile IN (
      'local-trading',
      'local-trading-onboarding',
      'local-trading-isolated-onboarding-v1'
    )
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal, hash)
);

INSERT INTO direct_submission_bindings
  (principal, hash, owner, network, origin_profile, created_at)
SELECT principal, hash, owner, network, origin_profile, created_at
  FROM direct_submission_bindings_before_isolated_onboarding_v1;

DROP TABLE direct_submission_bindings_before_isolated_onboarding_v1;

CREATE TRIGGER reject_direct_submission_binding_update
BEFORE UPDATE ON direct_submission_bindings
BEGIN
  SELECT RAISE(ABORT, 'direct submission bindings are immutable');
END;

CREATE TRIGGER reject_direct_submission_binding_delete
BEFORE DELETE ON direct_submission_bindings
BEGIN
  SELECT RAISE(ABORT, 'direct submission bindings are immutable');
END;

CREATE TRIGGER reject_build_origin_profile_change
BEFORE UPDATE OF origin_profile ON builds
WHEN NOT (OLD.origin_profile IS NEW.origin_profile)
BEGIN
  SELECT RAISE(ABORT, 'build origin profile is immutable');
END;

CREATE TRIGGER reject_origin_bearing_build_delete
BEFORE DELETE ON builds
WHEN OLD.origin_profile IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'origin-bearing builds are immutable');
END;
