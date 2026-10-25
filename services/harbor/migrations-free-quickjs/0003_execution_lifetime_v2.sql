ALTER TABLE builds ADD COLUMN build_revision INTEGER;
ALTER TABLE builds ADD COLUMN execution_contract TEXT CHECK (
  (
    execution_contract IS NULL AND
    build_revision IS NULL
  ) OR
  (
    execution_contract = 'xrpl_execution_v2' AND
    build_revision >= 1
  )
);

CREATE TRIGGER reject_legacy_build_upgrade
BEFORE UPDATE ON builds
WHEN OLD.execution_contract IS NULL AND (
  NEW.execution_contract IS NOT NULL OR
  NEW.build_revision IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'legacy build cannot be upgraded');
END;

CREATE TRIGGER validate_v2_build_pointer_update
BEFORE UPDATE ON builds
WHEN OLD.execution_contract = 'xrpl_execution_v2' AND (
  NEW.execution_contract IS NOT OLD.execution_contract OR
  NEW.build_revision IS NULL OR
  NEW.build_revision < OLD.build_revision OR
  NEW.build_revision > OLD.build_revision + 1
)
BEGIN
  SELECT RAISE(ABORT, 'invalid v2 build revision transition');
END;

CREATE UNIQUE INDEX idx_builds_principal_id
  ON builds(principal, id);

CREATE TABLE build_revisions (
  principal TEXT NOT NULL,
  build_id TEXT NOT NULL,
  build_revision INTEGER NOT NULL CHECK (build_revision >= 1),
  execution_contract TEXT NOT NULL CHECK (execution_contract = 'xrpl_execution_v2'),
  owner TEXT NOT NULL CHECK (length(owner) > 0),
  network TEXT NOT NULL CHECK (network IN ('testnet', 'devnet')),
  tx_json TEXT NOT NULL CHECK (json_valid(tx_json) AND json_type(tx_json) = 'object'),
  summary TEXT NOT NULL CHECK (json_valid(summary) AND json_type(summary) = 'object'),
  unsigned_tx_digest TEXT NOT NULL CHECK (
    length(unsigned_tx_digest) = 64 AND
    unsigned_tx_digest NOT GLOB '*[^0-9A-F]*'
  ),
  unsigned_tx_digest_alg TEXT NOT NULL CHECK (unsigned_tx_digest_alg = 'sha256-jcs-v1'),
  economic_fingerprint TEXT NOT NULL CHECK (
    length(economic_fingerprint) = 64 AND
    economic_fingerprint NOT GLOB '*[^0-9A-F]*'
  ),
  economic_fingerprint_alg TEXT NOT NULL CHECK (economic_fingerprint_alg = 'sha256-jcs-economic-v1'),
  build_ledger INTEGER NOT NULL CHECK (build_ledger > 0 AND build_ledger <= 4294967295),
  first_inclusion_ledger INTEGER NOT NULL CHECK (
    first_inclusion_ledger = build_ledger + 1 AND
    first_inclusion_ledger <= 4294967295
  ),
  last_ledger_sequence INTEGER NOT NULL CHECK (
    last_ledger_sequence = build_ledger + 64 AND
    last_ledger_sequence <= 4294967295
  ),
  minimum_remaining_ledgers INTEGER NOT NULL CHECK (minimum_remaining_ledgers = 8),
  approval_expires_in_seconds INTEGER NOT NULL CHECK (approval_expires_in_seconds = 90),
  quote_ledger INTEGER,
  quote_valid_through_ledger INTEGER,
  acquisition_balance_invariant TEXT CHECK (
    acquisition_balance_invariant IS NULL OR
    (
      json_valid(acquisition_balance_invariant) AND
      json_type(acquisition_balance_invariant) = 'object' AND
      json_type(acquisition_balance_invariant, '$.ledger_index') = 'integer' AND
      json_extract(acquisition_balance_invariant, '$.ledger_index')
        BETWEEN build_ledger - 1 AND build_ledger
    )
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (principal, build_id, build_revision),
  FOREIGN KEY (principal, build_id) REFERENCES builds(principal, id),
  CHECK (
    json_extract(tx_json, '$.Account') = owner AND
    json_type(tx_json, '$.Sequence') = 'integer' AND
    json_extract(tx_json, '$.Sequence') > 0 AND
    json_extract(tx_json, '$.Sequence') <= 4294967295 AND
    json_extract(tx_json, '$.LastLedgerSequence') = last_ledger_sequence
  ),
  CHECK (
    NOT (
      network = 'testnet' AND
      json_extract(tx_json, '$.TransactionType') = 'OfferCreate' AND
      upper(json_extract(tx_json, '$.TakerPays.currency')) = '524C555344000000000000000000000000000000' AND
      json_extract(tx_json, '$.TakerPays.issuer') = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV'
    ) OR (
      acquisition_balance_invariant IS NOT NULL AND
      COALESCE(json_extract(acquisition_balance_invariant, '$.kind') = 'issued_balance_unchanged', 0) AND
      COALESCE(json_extract(acquisition_balance_invariant, '$.currency') = '524C555344000000000000000000000000000000', 0) AND
      COALESCE(json_extract(acquisition_balance_invariant, '$.issuer') = 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV', 0)
    )
  ),
  CHECK (
    (quote_ledger IS NULL AND quote_valid_through_ledger IS NULL) OR
    (
      quote_ledger > 0 AND
      quote_valid_through_ledger = quote_ledger + 1 AND
      build_ledger >= quote_ledger AND
      build_ledger <= quote_valid_through_ledger
    )
  )
);

CREATE TRIGGER validate_build_revision_insert
BEFORE INSERT ON build_revisions
WHEN NOT EXISTS (
  SELECT 1
    FROM builds AS b
   WHERE b.principal = NEW.principal
     AND b.id = NEW.build_id
     AND b.owner = NEW.owner
     AND b.network = NEW.network
     AND b.summary = NEW.summary
     AND b.execution_contract = NEW.execution_contract
     AND b.build_revision = NEW.build_revision
)
BEGIN
  SELECT RAISE(ABORT, 'build revision does not match current build');
END;

CREATE TRIGGER reject_build_revision_update
BEFORE UPDATE ON build_revisions
BEGIN
  SELECT RAISE(ABORT, 'build revisions are immutable');
END;

CREATE TRIGGER reject_build_revision_delete
BEFORE DELETE ON build_revisions
BEGIN
  SELECT RAISE(ABORT, 'build revisions are immutable');
END;

ALTER TABLE approvals ADD COLUMN execution_id TEXT;
ALTER TABLE approvals ADD COLUMN build_revision INTEGER;
ALTER TABLE approvals ADD COLUMN execution_contract TEXT CHECK (
  (
    execution_contract IS NULL AND
    execution_id IS NULL AND
    build_revision IS NULL
  ) OR
  (
    execution_contract = 'xrpl_execution_v2' AND
    execution_id IS NOT NULL AND
    length(execution_id) > 0 AND
    build_revision >= 1
  )
);

CREATE INDEX idx_approvals_execution
  ON approvals(principal, execution_id);

CREATE TRIGGER reject_v2_approval_binding_update
BEFORE UPDATE ON approvals
WHEN OLD.execution_contract = 'xrpl_execution_v2' AND (
  NEW.id IS NOT OLD.id OR
  NEW.principal IS NOT OLD.principal OR
  NEW.build_id IS NOT OLD.build_id OR
  NEW.tx_json IS NOT OLD.tx_json OR
  NEW.expires_at IS NOT OLD.expires_at OR
  NEW.execution_id IS NOT OLD.execution_id OR
  NEW.execution_contract IS NOT OLD.execution_contract OR
  NEW.build_revision IS NOT OLD.build_revision
)
BEGIN
  SELECT RAISE(ABORT, 'v2 approval binding is immutable');
END;

CREATE TRIGGER reject_legacy_approval_upgrade
BEFORE UPDATE ON approvals
WHEN OLD.execution_contract IS NULL AND (
  NEW.execution_id IS NOT NULL OR
  NEW.execution_contract IS NOT NULL OR
  NEW.build_revision IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'legacy approval cannot be upgraded');
END;

CREATE TABLE execution_snapshots (
  execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
  principal TEXT NOT NULL CHECK (length(principal) > 0),
  build_id TEXT NOT NULL CHECK (length(build_id) > 0),
  execution_contract TEXT NOT NULL CHECK (execution_contract = 'xrpl_execution_v2'),
  build_revision INTEGER NOT NULL CHECK (build_revision >= 1),
  policy_snapshot TEXT NOT NULL CHECK (json_valid(policy_snapshot) AND json_type(policy_snapshot) = 'object'),
  policy_revision TEXT NOT NULL CHECK (length(policy_revision) > 0),
  unsigned_tx_digest TEXT NOT NULL CHECK (
    length(unsigned_tx_digest) = 64 AND
    unsigned_tx_digest NOT GLOB '*[^0-9A-F]*'
  ),
  unsigned_tx_digest_alg TEXT NOT NULL CHECK (unsigned_tx_digest_alg = 'sha256-jcs-v1'),
  economic_fingerprint TEXT NOT NULL CHECK (
    length(economic_fingerprint) = 64 AND
    economic_fingerprint NOT GLOB '*[^0-9A-F]*'
  ),
  economic_fingerprint_alg TEXT NOT NULL CHECK (economic_fingerprint_alg = 'sha256-jcs-economic-v1'),
  snapshot_owner TEXT NOT NULL CHECK (length(snapshot_owner) > 0),
  snapshot_network TEXT NOT NULL CHECK (snapshot_network IN ('testnet', 'devnet')),
  snapshot_sequence INTEGER NOT NULL CHECK (snapshot_sequence > 0 AND snapshot_sequence <= 4294967295),
  first_inclusion_ledger INTEGER NOT NULL CHECK (first_inclusion_ledger > 0 AND first_inclusion_ledger <= 4294967295),
  last_ledger_sequence INTEGER NOT NULL CHECK (
    last_ledger_sequence = first_inclusion_ledger + 63 AND
    last_ledger_sequence <= 4294967295
  ),
  approval_id TEXT,
  approval_expires_at TEXT,
  acquisition_balance_invariant TEXT CHECK (
    acquisition_balance_invariant IS NULL OR
    (json_valid(acquisition_balance_invariant) AND json_type(acquisition_balance_invariant) = 'object')
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) > 0),
  PRIMARY KEY (execution_id, principal, build_id),
  UNIQUE (principal, approval_id),
  FOREIGN KEY (principal, build_id, build_revision)
    REFERENCES build_revisions(principal, build_id, build_revision),
  CHECK (
    (approval_id IS NULL AND approval_expires_at IS NULL) OR
    (approval_id IS NOT NULL AND length(approval_id) > 0 AND approval_expires_at IS NOT NULL AND length(approval_expires_at) > 0)
  )
);

CREATE INDEX idx_execution_snapshots_revision
  ON execution_snapshots(principal, build_id, build_revision);

CREATE TRIGGER validate_execution_snapshot_insert
BEFORE INSERT ON execution_snapshots
WHEN
  NOT EXISTS (
    SELECT 1
      FROM executions AS e
     WHERE e.principal = NEW.principal
       AND e.id = NEW.execution_id
       AND e.build_id = NEW.build_id
  ) OR
  NOT EXISTS (
    SELECT 1
      FROM build_revisions AS r
     WHERE r.principal = NEW.principal
       AND r.build_id = NEW.build_id
       AND r.build_revision = NEW.build_revision
       AND r.execution_contract = NEW.execution_contract
       AND r.unsigned_tx_digest = NEW.unsigned_tx_digest
       AND r.unsigned_tx_digest_alg = NEW.unsigned_tx_digest_alg
       AND r.economic_fingerprint = NEW.economic_fingerprint
       AND r.economic_fingerprint_alg = NEW.economic_fingerprint_alg
       AND r.owner = NEW.snapshot_owner
       AND r.network = NEW.snapshot_network
       AND json_extract(r.tx_json, '$.Sequence') = NEW.snapshot_sequence
       AND r.first_inclusion_ledger = NEW.first_inclusion_ledger
       AND r.last_ledger_sequence = NEW.last_ledger_sequence
       AND r.acquisition_balance_invariant IS NEW.acquisition_balance_invariant
  ) OR
  (
    NEW.approval_id IS NOT NULL AND
    NOT EXISTS (
      SELECT 1
        FROM approvals AS a
       WHERE a.principal = NEW.principal
         AND a.id = NEW.approval_id
         AND a.execution_id = NEW.execution_id
         AND a.build_id = NEW.build_id
         AND a.execution_contract = NEW.execution_contract
         AND a.build_revision = NEW.build_revision
         AND a.expires_at = NEW.approval_expires_at
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'execution snapshot binding is invalid');
END;

CREATE TRIGGER reject_execution_snapshot_update
BEFORE UPDATE ON execution_snapshots
BEGIN
  SELECT RAISE(ABORT, 'execution snapshots are immutable');
END;

CREATE TRIGGER reject_execution_snapshot_delete
BEFORE DELETE ON execution_snapshots
BEGIN
  SELECT RAISE(ABORT, 'execution snapshots are immutable');
END;

CREATE TRIGGER reject_v2_execution_hash_rewrite
BEFORE UPDATE OF hash ON executions
WHEN EXISTS (
  SELECT 1 FROM execution_snapshots AS s
   WHERE s.principal = OLD.principal AND s.execution_id = OLD.id
) AND OLD.hash IS NOT NEW.hash AND (
  OLD.hash IS NOT NULL OR
  NEW.hash IS NULL OR
  length(NEW.hash) <> 64 OR
  NEW.hash GLOB '*[^0-9A-F]*'
)
BEGIN
  SELECT RAISE(ABORT, 'v2 execution hash is immutable');
END;

CREATE TRIGGER reject_execution_claim_update
BEFORE UPDATE ON events
WHEN OLD.kind = 'execution_claim'
BEGIN
  SELECT RAISE(ABORT, 'execution claims are immutable');
END;

CREATE TRIGGER reject_execution_claim_delete
BEFORE DELETE ON events
WHEN OLD.kind = 'execution_claim'
BEGIN
  SELECT RAISE(ABORT, 'execution claims are immutable');
END;

CREATE TABLE relay_claims (
  principal TEXT NOT NULL CHECK (length(principal) > 0),
  execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
  hash TEXT NOT NULL CHECK (
    length(hash) = 64 AND
    hash NOT GLOB '*[^0-9A-F]*'
  ),
  attempted_at TEXT NOT NULL CHECK (length(attempted_at) > 0),
  PRIMARY KEY (principal, execution_id, hash),
  UNIQUE (principal, execution_id),
  UNIQUE (principal, hash)
);

CREATE TRIGGER validate_relay_claim_insert
BEFORE INSERT ON relay_claims
WHEN NOT EXISTS (
  SELECT 1
    FROM executions AS e
   WHERE e.principal = NEW.principal
     AND e.id = NEW.execution_id
     AND e.hash = NEW.hash
)
BEGIN
  SELECT RAISE(ABORT, 'relay claim does not match execution hash');
END;

CREATE TRIGGER reject_relay_claim_update
BEFORE UPDATE ON relay_claims
BEGIN
  SELECT RAISE(ABORT, 'relay claims are immutable');
END;

CREATE TRIGGER reject_relay_claim_delete
BEFORE DELETE ON relay_claims
BEGIN
  SELECT RAISE(ABORT, 'relay claims are immutable');
END;
