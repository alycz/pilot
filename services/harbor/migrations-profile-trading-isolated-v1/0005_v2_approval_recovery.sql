CREATE TABLE approval_recoveries (
  principal TEXT NOT NULL CHECK (length(principal) > 0),
  approval_id TEXT NOT NULL CHECK (length(approval_id) > 0),
  execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
  build_id TEXT NOT NULL CHECK (length(build_id) > 0),
  build_revision INTEGER NOT NULL CHECK (build_revision >= 1),
  unsigned_tx_digest TEXT NOT NULL CHECK (
    length(unsigned_tx_digest) = 64 AND
    unsigned_tx_digest NOT GLOB '*[^0-9A-F]*'
  ),
  economic_fingerprint TEXT NOT NULL CHECK (
    length(economic_fingerprint) = 64 AND
    economic_fingerprint NOT GLOB '*[^0-9A-F]*'
  ),
  validated_ledger INTEGER NOT NULL CHECK (
    validated_ledger > last_ledger_sequence AND validated_ledger <= 4294967295
  ),
  first_inclusion_ledger INTEGER NOT NULL CHECK (first_inclusion_ledger > 0),
  last_ledger_sequence INTEGER NOT NULL CHECK (
    last_ledger_sequence = first_inclusion_ledger + 63 AND
    last_ledger_sequence <= 4294967295
  ),
  recovered_at TEXT NOT NULL CHECK (length(recovered_at) > 0),
  PRIMARY KEY (principal, approval_id),
  UNIQUE (principal, execution_id),
  UNIQUE (principal, build_id, build_revision)
);

CREATE TRIGGER validate_approval_recovery_insert
BEFORE INSERT ON approval_recoveries
WHEN NOT EXISTS (
  SELECT 1
    FROM approvals AS a
    JOIN executions AS e
      ON e.principal = a.principal AND e.id = a.execution_id
    JOIN execution_snapshots AS s
      ON s.principal = a.principal AND s.execution_id = a.execution_id
    JOIN build_revisions AS r
      ON r.principal = a.principal
     AND r.build_id = a.build_id
     AND r.build_revision = a.build_revision
    JOIN events AS ev
      ON ev.principal = e.principal
     AND ev.id = 'execution-result:' || e.id
     AND ev.kind = 'execution_result'
   WHERE a.principal = NEW.principal
     AND a.id = NEW.approval_id
     AND a.execution_id = NEW.execution_id
     AND a.build_id = NEW.build_id
     AND a.build_revision = NEW.build_revision
     AND a.execution_contract = 'xrpl_execution_v2'
     AND a.status = 'preflighted'
     AND e.build_id = a.build_id
     AND e.status = 'needs_approval'
     AND e.hash IS NULL
     AND e.signed_by IS NULL
     AND s.build_id = a.build_id
     AND s.build_revision = a.build_revision
     AND s.approval_id = a.id
     AND s.unsigned_tx_digest = NEW.unsigned_tx_digest
     AND s.economic_fingerprint = NEW.economic_fingerprint
     AND s.first_inclusion_ledger = NEW.first_inclusion_ledger
     AND s.last_ledger_sequence = NEW.last_ledger_sequence
     AND r.unsigned_tx_digest = NEW.unsigned_tx_digest
     AND r.economic_fingerprint = NEW.economic_fingerprint
     AND json_extract(ev.detail, '$.result.status') = 'needs_approval'
     AND NOT EXISTS (
       SELECT 1 FROM relay_claims AS c
        WHERE c.principal = a.principal AND c.execution_id = a.execution_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM approval_preflight_rejections AS p
        WHERE p.principal = a.principal AND p.approval_id = a.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM executions AS other
        WHERE other.principal = a.principal
          AND other.build_id = a.build_id
          AND other.id <> a.execution_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'approval recovery is not claimable');
END;

CREATE TRIGGER finalize_approval_recovery_insert
AFTER INSERT ON approval_recoveries
BEGIN
  UPDATE approvals
     SET status = 'expired'
   WHERE principal = NEW.principal
     AND id = NEW.approval_id
     AND execution_id = NEW.execution_id
     AND status = 'preflighted';

  UPDATE executions
     SET status = 'failed'
   WHERE principal = NEW.principal
     AND id = NEW.execution_id
     AND build_id = NEW.build_id
     AND status = 'needs_approval'
     AND hash IS NULL
     AND signed_by IS NULL;

  UPDATE events
     SET detail = '{"result":{"status":"failed","engine_result":"APPROVAL_RECOVERED_NONINCLUSION","detail":"Unsigned owner approval expired with complete non-inclusion proof"}}'
   WHERE principal = NEW.principal
     AND id = 'execution-result:' || NEW.execution_id
     AND kind = 'execution_result';

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM approvals AS a
      JOIN executions AS e
        ON e.principal = a.principal AND e.id = a.execution_id
      JOIN events AS ev
        ON ev.principal = e.principal
       AND ev.id = 'execution-result:' || e.id
       AND ev.kind = 'execution_result'
     WHERE a.principal = NEW.principal
       AND a.id = NEW.approval_id
       AND a.execution_id = NEW.execution_id
       AND a.status = 'expired'
       AND e.status = 'failed'
       AND e.hash IS NULL
       AND e.signed_by IS NULL
       AND json_extract(ev.detail, '$.result.status') = 'failed'
       AND json_extract(ev.detail, '$.result.engine_result') = 'APPROVAL_RECOVERED_NONINCLUSION'
  ) THEN RAISE(ABORT, 'approval recovery did not finalize atomically') END;
END;

CREATE TRIGGER reject_approval_recovery_update
BEFORE UPDATE ON approval_recoveries
BEGIN
  SELECT RAISE(ABORT, 'approval recoveries are immutable');
END;

CREATE TRIGGER reject_approval_recovery_delete
BEFORE DELETE ON approval_recoveries
BEGIN
  SELECT RAISE(ABORT, 'approval recoveries are immutable');
END;

CREATE TRIGGER reject_recovered_build_execution
BEFORE INSERT ON executions
WHEN EXISTS (
  SELECT 1 FROM approval_recoveries AS r
   WHERE r.principal = NEW.principal AND r.build_id = NEW.build_id
)
BEGIN
  SELECT RAISE(ABORT, 'recovered build is permanently burned');
END;
