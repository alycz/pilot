-- Review-only NEAR hosted attempt persistence. This migration is not applied by
-- source code. Atomic amounts remain canonical decimal TEXT because D1/SQLite
-- INTEGER and the Workers binding cannot safely represent NEAR-scale values.
-- The Worker computes exact addition/subtraction with validated BigInt strings;
-- triggers enforce the exact prior value+revision CAS, monotonic direction, and
-- admission bound in the same transaction as the attempt mutation.

CREATE TABLE near_attempt_budget_counters (
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200),
  principal_id TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 200),
  network TEXT NOT NULL CHECK (network = 'near:mainnet'),
  asset_id TEXT NOT NULL CHECK (length(asset_id) BETWEEN 3 AND 320),
  consumed_atomic TEXT NOT NULL CHECK (
    length(consumed_atomic) BETWEEN 1 AND 128
    AND consumed_atomic NOT GLOB '*[^0-9]*'
    AND (consumed_atomic = '0' OR substr(consumed_atomic, 1, 1) BETWEEN '1' AND '9')
  ),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  last_mutation_token TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, network, asset_id)
) STRICT;

CREATE TABLE near_hosted_attempts (
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 200),
  principal_id TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND 200),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 2 AND 64),
  network TEXT NOT NULL CHECK (network = 'near:mainnet'),
  authorization_id TEXT NOT NULL CHECK (length(authorization_id) BETWEEN 1 AND 200),
  idempotency_version TEXT NOT NULL CHECK (idempotency_version = 'pilot-near-idempotency-v1'),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_digest TEXT NOT NULL CHECK (
    length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9A-F]*'
  ),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64 AND request_fingerprint NOT GLOB '*[^0-9A-F]*'
  ),
  attempt_id TEXT NOT NULL CHECK (length(attempt_id) BETWEEN 1 AND 200),
  reservation_id TEXT NOT NULL CHECK (length(reservation_id) BETWEEN 1 AND 200),
  approval_digest TEXT NOT NULL CHECK (
    length(approval_digest) = 64 AND approval_digest NOT GLOB '*[^0-9A-F]*'
  ),
  policy_digest TEXT NOT NULL CHECK (
    length(policy_digest) = 64 AND policy_digest NOT GLOB '*[^0-9A-F]*'
  ),
  quote_id TEXT NOT NULL CHECK (length(quote_id) BETWEEN 1 AND 200),
  quote_hash TEXT NOT NULL CHECK (length(quote_hash) BETWEEN 43 AND 45),
  deposit_address TEXT NOT NULL CHECK (length(deposit_address) BETWEEN 1 AND 512),
  deposit_memo TEXT CHECK (deposit_memo IS NULL OR length(deposit_memo) BETWEEN 1 AND 512),
  asset_id TEXT NOT NULL CHECK (length(asset_id) BETWEEN 3 AND 320),
  amount_atomic TEXT NOT NULL CHECK (
    length(amount_atomic) BETWEEN 1 AND 128
    AND amount_atomic NOT GLOB '*[^0-9]*'
    AND substr(amount_atomic, 1, 1) BETWEEN '1' AND '9'
  ),
  budget_limit_atomic TEXT NOT NULL CHECK (
    length(budget_limit_atomic) BETWEEN 1 AND 128
    AND budget_limit_atomic NOT GLOB '*[^0-9]*'
    AND substr(budget_limit_atomic, 1, 1) BETWEEN '1' AND '9'
  ),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind = 'provider_verified_executable_quote'),
  state TEXT NOT NULL CHECK (state IN ('approved','unknown','pending','settled','refunded','failed')),
  reservation_state TEXT NOT NULL CHECK (reservation_state IN ('reserved','outcome_unknown','committed','released')),
  provider_status TEXT CHECK (provider_status IS NULL OR provider_status IN (
    'KNOWN_DEPOSIT_TX','PENDING_DEPOSIT','INCOMPLETE_DEPOSIT','PROCESSING','SUCCESS','REFUNDED','FAILED'
  )),
  entry_revision INTEGER NOT NULL CHECK (entry_revision >= 1),
  reservation_revision INTEGER NOT NULL CHECK (reservation_revision >= 1),
  authorization_expires_at TEXT NOT NULL,
  approval_expires_at TEXT NOT NULL,
  provider_deadline_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  unknown_since TEXT,
  last_transition_id TEXT,
  last_evidence_outcome TEXT CHECK (
    last_evidence_outcome IS NULL OR last_evidence_outcome IN ('unknown','pending','terminal')
  ),
  last_provider_status TEXT CHECK (
    last_provider_status IS NULL OR last_provider_status IN (
      'KNOWN_DEPOSIT_TX','PENDING_DEPOSIT','INCOMPLETE_DEPOSIT','PROCESSING','SUCCESS','REFUNDED','FAILED'
    )
  ),
  last_unknown_reason TEXT CHECK (
    last_unknown_reason IS NULL OR last_unknown_reason IN (
      'timeout','transport_error','not_found','invalid_response','unavailable'
    )
  ),
  last_evidence_digest TEXT CHECK (
    last_evidence_digest IS NULL OR (
      length(last_evidence_digest) = 64 AND last_evidence_digest NOT GLOB '*[^0-9A-F]*'
    )
  ),
  last_safe_to_resubmit INTEGER CHECK (last_safe_to_resubmit IS NULL OR last_safe_to_resubmit = 0),
  last_evidence_json TEXT CHECK (last_evidence_json IS NULL OR json_valid(last_evidence_json)),
  counter_expected_atomic TEXT NOT NULL CHECK (
    length(counter_expected_atomic) BETWEEN 1 AND 128
    AND counter_expected_atomic NOT GLOB '*[^0-9]*'
    AND (counter_expected_atomic = '0' OR substr(counter_expected_atomic, 1, 1) BETWEEN '1' AND '9')
  ),
  counter_expected_revision INTEGER NOT NULL CHECK (counter_expected_revision >= 0),
  counter_next_atomic TEXT NOT NULL CHECK (
    length(counter_next_atomic) BETWEEN 1 AND 128
    AND counter_next_atomic NOT GLOB '*[^0-9]*'
    AND (counter_next_atomic = '0' OR substr(counter_next_atomic, 1, 1) BETWEEN '1' AND '9')
  ),
  PRIMARY KEY (tenant_id, principal_id, idempotency_key),
  UNIQUE (tenant_id, attempt_id),
  UNIQUE (tenant_id, reservation_id),
  FOREIGN KEY (tenant_id, principal_id, network, asset_id)
    REFERENCES near_attempt_budget_counters(tenant_id, principal_id, network, asset_id),
  CHECK (request_digest = request_fingerprint),
  CHECK (
    (state = 'approved' AND reservation_state = 'reserved' AND provider_status IS NULL AND unknown_since IS NULL)
    OR (state = 'unknown' AND reservation_state = 'outcome_unknown' AND provider_status IS NULL AND unknown_since IS NOT NULL)
    OR (state = 'pending' AND reservation_state = 'outcome_unknown' AND provider_status IN (
      'KNOWN_DEPOSIT_TX','PENDING_DEPOSIT','INCOMPLETE_DEPOSIT','PROCESSING'
    ) AND unknown_since IS NULL)
    OR (state = 'settled' AND reservation_state = 'committed' AND provider_status = 'SUCCESS' AND unknown_since IS NULL)
    OR (state = 'refunded' AND reservation_state = 'released' AND provider_status = 'REFUNDED' AND unknown_since IS NULL)
    OR (state = 'failed' AND reservation_state = 'released' AND provider_status = 'FAILED' AND unknown_since IS NULL)
  )
) STRICT;

CREATE INDEX idx_near_hosted_attempt_budget_scope
  ON near_hosted_attempts(tenant_id, principal_id, account_id, network, asset_id, reservation_state);

CREATE TABLE near_attempt_reconciliation_evidence (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  transition_id TEXT NOT NULL CHECK (length(transition_id) BETWEEN 1 AND 200),
  entry_revision INTEGER NOT NULL CHECK (entry_revision >= 2),
  outcome TEXT NOT NULL CHECK (outcome IN ('unknown','pending','terminal')),
  provider_status TEXT,
  unknown_reason TEXT,
  evidence_digest TEXT,
  safe_to_resubmit INTEGER NOT NULL CHECK (safe_to_resubmit = 0),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  checked_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, idempotency_key, transition_id),
  FOREIGN KEY (tenant_id, principal_id, idempotency_key)
    REFERENCES near_hosted_attempts(tenant_id, principal_id, idempotency_key)
) STRICT;

CREATE TRIGGER near_attempt_reserve_budget_cas
AFTER INSERT ON near_hosted_attempts
BEGIN
  UPDATE near_attempt_budget_counters
  SET consumed_atomic = NEW.counter_next_atomic,
      revision = revision + 1,
      last_mutation_token = NEW.reservation_id,
      updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id
    AND principal_id = NEW.principal_id
    AND network = NEW.network
    AND asset_id = NEW.asset_id
    AND consumed_atomic = NEW.counter_expected_atomic
    AND revision = NEW.counter_expected_revision
    AND (
      length(NEW.counter_next_atomic) > length(NEW.counter_expected_atomic)
      OR (
        length(NEW.counter_next_atomic) = length(NEW.counter_expected_atomic)
        AND NEW.counter_next_atomic > NEW.counter_expected_atomic
      )
    )
    AND (
      length(NEW.counter_next_atomic) < length(NEW.budget_limit_atomic)
      OR (
        length(NEW.counter_next_atomic) = length(NEW.budget_limit_atomic)
        AND NEW.counter_next_atomic <= NEW.budget_limit_atomic
      )
    );
  SELECT RAISE(ABORT, 'near budget reservation CAS conflict') WHERE changes() <> 1;
END;

CREATE TRIGGER near_attempt_immutable_identity
BEFORE UPDATE ON near_hosted_attempts
WHEN NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.principal_id IS NOT OLD.principal_id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.network IS NOT OLD.network
  OR NEW.authorization_id IS NOT OLD.authorization_id
  OR NEW.idempotency_version IS NOT OLD.idempotency_version
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.request_fingerprint IS NOT OLD.request_fingerprint
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.reservation_id IS NOT OLD.reservation_id
  OR NEW.approval_digest IS NOT OLD.approval_digest
  OR NEW.policy_digest IS NOT OLD.policy_digest
  OR NEW.quote_id IS NOT OLD.quote_id
  OR NEW.quote_hash IS NOT OLD.quote_hash
  OR NEW.deposit_address IS NOT OLD.deposit_address
  OR NEW.deposit_memo IS NOT OLD.deposit_memo
  OR NEW.asset_id IS NOT OLD.asset_id
  OR NEW.amount_atomic IS NOT OLD.amount_atomic
  OR NEW.budget_limit_atomic IS NOT OLD.budget_limit_atomic
  OR NEW.artifact_kind IS NOT OLD.artifact_kind
  OR NEW.authorization_expires_at IS NOT OLD.authorization_expires_at
  OR NEW.approval_expires_at IS NOT OLD.approval_expires_at
  OR NEW.provider_deadline_at IS NOT OLD.provider_deadline_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'near attempt immutable identity changed');
END;

CREATE TRIGGER near_attempt_transition_guard
BEFORE UPDATE ON near_hosted_attempts
BEGIN
  SELECT RAISE(ABORT, 'near attempt revision conflict')
    WHERE NEW.entry_revision <> OLD.entry_revision + 1
      OR NEW.reservation_revision < OLD.reservation_revision
      OR NEW.reservation_revision > OLD.reservation_revision + 1;
  SELECT RAISE(ABORT, 'near attempt evidence missing')
    WHERE NEW.last_transition_id IS NULL
      OR NEW.last_evidence_outcome IS NULL
      OR NEW.last_safe_to_resubmit IS NOT 0
      OR NEW.last_evidence_json IS NULL;
  SELECT RAISE(ABORT, 'near attempt evidence shape invalid')
    WHERE NOT (
      (NEW.last_evidence_outcome = 'unknown'
        AND NEW.last_unknown_reason IS NOT NULL
        AND NEW.last_provider_status IS NULL
        AND NEW.last_evidence_digest IS NULL)
      OR (NEW.last_evidence_outcome = 'pending'
        AND NEW.last_unknown_reason IS NULL
        AND NEW.last_provider_status IN (
          'KNOWN_DEPOSIT_TX','PENDING_DEPOSIT','INCOMPLETE_DEPOSIT','PROCESSING'
        )
        AND NEW.last_evidence_digest IS NULL)
      OR (NEW.last_evidence_outcome = 'terminal'
        AND NEW.last_unknown_reason IS NULL
        AND NEW.last_provider_status IN ('SUCCESS','REFUNDED','FAILED')
        AND NEW.last_evidence_digest IS NOT NULL)
    );
  SELECT RAISE(ABORT, 'near attempt state transition invalid')
    WHERE NOT (
      (OLD.state = 'approved' AND NEW.state = 'unknown'
        AND OLD.reservation_state = 'reserved' AND NEW.reservation_state = 'outcome_unknown'
        AND NEW.reservation_revision = OLD.reservation_revision + 1
        AND NEW.last_evidence_outcome = 'unknown')
      OR (OLD.state IN ('unknown','pending') AND NEW.state = 'unknown'
        AND OLD.reservation_state = 'outcome_unknown' AND NEW.reservation_state = 'outcome_unknown'
        AND NEW.reservation_revision = OLD.reservation_revision + 1
        AND NEW.last_evidence_outcome = 'unknown')
      OR (OLD.state IN ('unknown','pending') AND NEW.state = 'pending'
        AND OLD.reservation_state = 'outcome_unknown' AND NEW.reservation_state = 'outcome_unknown'
        AND NEW.reservation_revision = OLD.reservation_revision
        AND NEW.last_evidence_outcome = 'pending')
      OR (OLD.state IN ('unknown','pending') AND NEW.state = 'settled'
        AND OLD.reservation_state = 'outcome_unknown' AND NEW.reservation_state = 'committed'
        AND NEW.reservation_revision = OLD.reservation_revision + 1
        AND NEW.last_evidence_outcome = 'terminal' AND NEW.last_provider_status = 'SUCCESS'
        AND NEW.last_evidence_digest IS NOT NULL)
      OR (OLD.state IN ('unknown','pending') AND NEW.state IN ('refunded','failed')
        AND OLD.reservation_state = 'outcome_unknown' AND NEW.reservation_state = 'released'
        AND NEW.reservation_revision = OLD.reservation_revision + 1
        AND NEW.last_evidence_outcome = 'terminal' AND NEW.last_evidence_digest IS NOT NULL)
    );
END;

CREATE TRIGGER near_attempt_release_budget_cas
AFTER UPDATE ON near_hosted_attempts
WHEN OLD.reservation_state = 'outcome_unknown' AND NEW.reservation_state = 'released'
BEGIN
  UPDATE near_attempt_budget_counters
  SET consumed_atomic = NEW.counter_next_atomic,
      revision = revision + 1,
      last_mutation_token = NEW.last_transition_id,
      updated_at = NEW.updated_at
  WHERE tenant_id = NEW.tenant_id
    AND principal_id = NEW.principal_id
    AND network = NEW.network
    AND asset_id = NEW.asset_id
    AND consumed_atomic = NEW.counter_expected_atomic
    AND revision = NEW.counter_expected_revision
    AND (
      length(NEW.counter_next_atomic) < length(NEW.counter_expected_atomic)
      OR (
        length(NEW.counter_next_atomic) = length(NEW.counter_expected_atomic)
        AND NEW.counter_next_atomic < NEW.counter_expected_atomic
      )
    );
  SELECT RAISE(ABORT, 'near budget release CAS conflict') WHERE changes() <> 1;
END;

CREATE TRIGGER near_attempt_append_evidence
AFTER UPDATE ON near_hosted_attempts
BEGIN
  INSERT INTO near_attempt_reconciliation_evidence (
    tenant_id, principal_id, idempotency_key, transition_id, entry_revision,
    outcome, provider_status, unknown_reason, evidence_digest, safe_to_resubmit,
    evidence_json, checked_at
  ) VALUES (
    NEW.tenant_id, NEW.principal_id, NEW.idempotency_key, NEW.last_transition_id,
    NEW.entry_revision, NEW.last_evidence_outcome, NEW.last_provider_status,
    NEW.last_unknown_reason, NEW.last_evidence_digest, NEW.last_safe_to_resubmit,
    NEW.last_evidence_json, NEW.updated_at
  );
END;
