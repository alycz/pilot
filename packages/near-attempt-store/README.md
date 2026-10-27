# NEAR attempt store

This package provides local/internal-test persistence for NEAR Intents attempt
state. It does not quote, connect wallets, sign, deposit, submit, broadcast, or
call providers. Dry quotes, fixtures, expired principal authorizations, and
unverified executable quotes cannot reserve execution budget.

The local file adapter writes a synced temporary file and atomically renames it,
with an in-process transaction queue. It supports deterministic restart and
crash-boundary tests on one host. It is not safe for multiple processes,
serverless replicas, shared network filesystems, or production funds.

## Hosted migration review required

Before enabling any hosted execution, replace the local adapter with a reviewed
transactional database implementation. The migration must include:

- a schema-version gate and backup/rollback rehearsal;
- a unique `(principal_id, idempotency_key)` constraint plus immutable request
  version and digest;
- exact integer or decimal storage for atomic amounts, never floating point;
- serializable reservation or row-lock/CAS semantics that check and reserve the
  budget in one transaction;
- durable record revisions and append-only reconciliation evidence;
- reservation preservation for unknown outcomes, with no TTL-based or automatic
  release;
- matching terminal evidence before commit or release;
- tenant isolation, encryption, access logging, retention, and restore tests;
- multi-worker concurrency, crash-after-commit, and retry/replay acceptance
  tests against the selected hosted database.

No database migration is generated or applied by this package.

`evidence_digest` is only a structural durable-reference field in this local
slice. The store does not authenticate provider responses or independently
confirm destination-chain settlement. A future executor must derive that digest
from verified provider evidence and keep `SUCCESS` provider-reported until
destination evidence is separately accepted.
