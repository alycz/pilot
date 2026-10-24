CREATE TABLE approval_preflight_rejections (
  principal TEXT NOT NULL CHECK (length(principal) > 0),
  approval_id TEXT NOT NULL CHECK (length(approval_id) > 0),
  execution_id TEXT NOT NULL CHECK (length(execution_id) > 0),
  error_code TEXT NOT NULL CHECK (error_code IN (
    'EXECUTION_SNAPSHOT_STALE',
    'EXECUTION_SNAPSHOT_INVALID',
    'TRANSACTION_WINDOW_TOO_SHORT',
    'FEE_LOAD_UNSAFE',
    'ACCOUNT_SEQUENCE_CHANGED',
    'BALANCE_INVARIANT_CHANGED'
  )),
  rejected_at TEXT NOT NULL CHECK (length(rejected_at) > 0),
  PRIMARY KEY (principal, approval_id),
  UNIQUE (principal, execution_id)
);

CREATE TRIGGER validate_approval_preflight_rejection_insert
BEFORE INSERT ON approval_preflight_rejections
WHEN NOT EXISTS (
  SELECT 1
    FROM approvals AS a
    JOIN executions AS e
      ON e.principal = a.principal AND e.id = a.execution_id
    JOIN execution_snapshots AS s
      ON s.principal = a.principal AND s.execution_id = a.execution_id
   WHERE a.principal = NEW.principal
     AND a.id = NEW.approval_id
     AND a.execution_id = NEW.execution_id
     AND a.execution_contract = 'xrpl_execution_v2'
     AND a.status = 'pending'
     AND e.build_id = a.build_id
     AND e.status = 'needs_approval'
     AND e.hash IS NULL
     AND e.signed_by IS NULL
     AND s.build_id = a.build_id
     AND s.build_revision = a.build_revision
     AND s.approval_id = a.id
)
BEGIN
  SELECT RAISE(ABORT, 'preflight rejection is not claimable');
END;

CREATE TRIGGER finalize_approval_preflight_rejection_insert
AFTER INSERT ON approval_preflight_rejections
BEGIN
  UPDATE approvals
     SET status = 'rejected'
   WHERE principal = NEW.principal
     AND id = NEW.approval_id
     AND execution_id = NEW.execution_id
     AND status = 'pending';

  UPDATE executions
     SET status = 'failed'
   WHERE principal = NEW.principal
     AND id = NEW.execution_id
     AND status = 'needs_approval'
     AND hash IS NULL
     AND signed_by IS NULL;

  UPDATE events
     SET detail = '{"result":{"status":"failed","engine_result":"'
       || NEW.error_code
       || '","detail":"Owner approval failed preflight before signing"}}'
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
       AND a.status = 'rejected'
       AND e.status = 'failed'
       AND e.hash IS NULL
       AND e.signed_by IS NULL
       AND ev.detail = '{"result":{"status":"failed","engine_result":"'
         || NEW.error_code
         || '","detail":"Owner approval failed preflight before signing"}}'
  ) THEN RAISE(ABORT, 'preflight rejection did not finalize atomically') END;
END;

CREATE TRIGGER reject_approval_preflight_rejection_update
BEFORE UPDATE ON approval_preflight_rejections
BEGIN
  SELECT RAISE(ABORT, 'preflight rejections are immutable');
END;

CREATE TRIGGER reject_approval_preflight_rejection_delete
BEFORE DELETE ON approval_preflight_rejections
BEGIN
  SELECT RAISE(ABORT, 'preflight rejections are immutable');
END;
