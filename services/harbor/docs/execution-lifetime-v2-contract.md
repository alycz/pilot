# Local XRPL execution lifetime contract

Status: provisional local-only contract for coordinated Harbor/Pilot implementation.
It is not a deployed or production-proven policy.

## Negotiation

The request field is `execution_contract`.

- `"xrpl_execution_v1"` is the legacy contract. Omitting the field is exactly
  equivalent to selecting this value.
- `"xrpl_execution_v2"` is the bounded local contract. Harbor accepts it only
  from an exact reviewed local trading or local trading onboarding profile.
  Hosted and non-profile requests fail closed.

Pilot sends the same `execution_contract` value to the build operation
(`tx.swap` or `tx.trustSet`) and to `tx.execute`. For v2, `tx.execute` also sends
the exact `build_revision` returned by the build. A mismatch is rejected before
approval creation, signing, or submission. There is no caller-provided ledger
offset, expiry, fee, or minimum-remaining override.

Downgrades fail closed. An omitted contract selects v1 only. A v2 request must
receive and preserve a complete v2 capability, and v1 rejects an unsolicited
v2 capability. Missing, malformed, or mixed-version evidence is never treated
as v1.

The build response includes this optional object for v2. Its absence means v1:

```json
{
  "execution_capability": {
    "execution_contract": "xrpl_execution_v2",
    "build_revision": 1,
    "unsigned_tx_digest": "64 uppercase hex characters",
    "unsigned_tx_digest_alg": "sha256-jcs-v1",
    "economic_fingerprint": "64 uppercase hex characters",
    "economic_fingerprint_alg": "sha256-jcs-economic-v1",
    "build_ledger": 6200000,
    "first_inclusion_ledger": 6200001,
    "last_ledger_sequence": 6200064,
    "minimum_remaining_ledgers": 8,
    "approval_expires_in_seconds": 90,
    "quote_ledger": 6200000,
    "quote_valid_through_ledger": 6200001,
    "acquisition_balance_invariant": {
      "kind": "issued_balance_unchanged",
      "currency": "524C555344000000000000000000000000000000",
      "issuer": "r...",
      "balance": "0",
      "ledger_index": 6200000
    }
  }
}
```

`quote_ledger` and `quote_valid_through_ledger` are present only for a
market-derived quote. Quote freshness is checked while constructing the exact
transaction: the build ledger may be at most one ledger after the quote ledger.
It is not the transaction inclusion horizon. FOK, the exact amounts, flags,
limit/slippage fields, and the economic fingerprint prevent Harbor from
silently changing the approved economics later.

`acquisition_balance_invariant` is present only when the v2 build acquires
official testnet RLUSD. Harbor obtains the exact issued balance and ledger from
a validated read before the build. Its `ledger_index` is either exactly
`build_ledger` or the immediately preceding ledger; older or future-dated
evidence fails the build. Harbor then requires exact balance equality before
owner signing and before first relay. Sequence equality alone is insufficient
because an incoming transfer does not consume the owner's Sequence.

## Fixed policy values

| Contract | Last-ledger offset | Minimum remaining at signature/first relay | Owner approval wall TTL |
| --- | ---: | ---: | ---: |
| `xrpl_execution_v1` | 4 | legacy behavior | legacy 10 minutes |
| `xrpl_execution_v2` | 64 | 8 validated ledgers | 90 seconds |

For v2, `build_ledger` is the validated ledger used to construct the build,
`first_inclusion_ledger = build_ledger + 1`, and
`last_ledger_sequence = build_ledger + 64`. Harbor persists both bounds. It
never reconstructs a v2 start with `LastLedgerSequence - 3`.

The existing approval response field `expires_at` remains the public approval
deadline and is an RFC 3339 UTC timestamp. For v2 it is exactly 90 seconds from
approval creation. The execution snapshot stores the identical value as
`approval_expires_at`. Effective validity ends at the first of:

1. `approval_expires_at`, or
2. the XRPL `LastLedgerSequence` bound.

Exactly 8 remaining ledgers is accepted. 7 is rejected. The check is made
immediately before delegated signing and again immediately before the first
relay. Owner-signed approval relay receives the same pre-relay check.

## Canonical binding

`build_revision` is scoped to one `build_id` and starts at 1. This increment
does not expose an in-place v2 refresh operation, so every fresh `tx.swap` or
`tx.trustSet` creates a new `build_id` whose revision is 1. Pilot must never
synthesize revision `n + 1`. A later in-place refresh API may use higher
revisions, but it is not part of this contract. An approved or signed
transaction is never refreshed or rewritten.

V2 revisions are immutable rows, unique by `(principal, build_id,
build_revision)`. A mutable current-build row is not authoritative for an
approval, signature, submission, or reconciliation. Replacing an unsigned
expired attempt means obtaining and preserving the fresh build's new
`(build_id, build_revision, unsigned_tx_digest, economic_fingerprint)` tuple;
the expired tuple is non-retryable.

The revision also stores the immutable build summary and policy valuation
facts used by execution. Later mutation of the compatibility `builds` row
cannot change v2 authorization or budget accounting.

`unsigned_tx_digest` is uppercase SHA-256 over RFC 8785 JSON Canonicalization
Scheme bytes for the exact unsigned transaction after removing only
`SigningPubKey`, `TxnSignature`, and `Signers`. The algorithm identifier is
`sha256-jcs-v1`. Canonicalization recursively sorts object keys by UTF-16 code
units, preserves array order and JSON scalar types, uses ECMAScript JSON string
escaping/number serialization, emits UTF-8, and has no insignificant
whitespace.

`economic_fingerprint` is uppercase SHA-256 over the same canonical encoding of
this object:

```json
{
  "owner": "r...",
  "network": "testnet",
  "transaction": "the unsigned transaction with only Fee, Sequence, LastLedgerSequence, SigningPubKey, TxnSignature, Signers, and Delegate removed"
}
```

Its algorithm identifier is `sha256-jcs-economic-v1`.

For delegated execution, Harbor first requires the signed blob's `Delegate` to
equal the active linked delegate. It then removes that exact Harbor-added
`Delegate` together with signature fields and compares the remaining canonical
transaction to the immutable owner-form revision. The two digests are
recomputed from that normalized transaction. A different delegate or any other
transaction-field change fails before relay.

This binds the exact amounts, counterparties/assets, slippage/limit values,
FOK/IOC and sell flags, source tag, intent memo, transaction type, owner, and
network. Harbor does not accept a caller-supplied digest or fingerprint.

## Durable execution snapshot

The immutable v2 snapshot is inserted only once all of its fields are known.
For approvals it is inserted in the same D1 batch as the approval and execution
transition. For delegated execution it is inserted in the same atomic budget
reservation that authorizes signing. Legacy executions have no snapshot and
permanently use v1 behavior. The persisted v2 fields are:

- `execution_contract`
- `build_revision`
- `policy_snapshot` and `policy_revision`
- `unsigned_tx_digest`
- `unsigned_tx_digest_alg`
- `economic_fingerprint`
- `economic_fingerprint_alg`
- `snapshot_owner`
- `snapshot_network`
- `snapshot_sequence`
- `first_inclusion_ledger`
- `last_ledger_sequence`
- `approval_id` and `approval_expires_at` (both present for an approval
  snapshot, both absent for delegated execution)

Snapshots reject update and deletion. The signed hash transitions only from
null to one exact `executions.hash` and is durable before the first relay. A
separate insert-only relay claim containing that execution and hash is persisted
before the sole network call. Its existence forbids any later relay or
resubmission. Reconciliation reads only the snapshot bounds and identity, never
mutable `builds` columns. A missing, partial, malformed, stale, or mismatched v2
snapshot fails closed.

Before a delegated v2 claim is created, Harbor validates the live ledger
window, exact-ledger owner sequence, fee/load evidence, and optional balance
invariant. A failed pre-claim check creates no execution and consumes no
one-time onboarding allowance. The atomic claim itself durably records the v2
contract and revision, so an interrupted later attempt cannot be retried as v1.

Current owner sequence and fee/load viability are checked before signing and
first relay. Harbor requires a canonical positive `drops.open_ledger_fee` no
greater than the immutable transaction Fee, plus canonical nonnegative
`current_queue_size` and positive `max_queue_size` with
`current_queue_size < max_queue_size`. Missing or malformed evidence fails
closed. Harbor never increases the fee or changes Sequence to rescue a v2
transaction.

The owner Sequence and optional issued-balance rechecks are requested at the
same exact validated ledger index used for the remaining-window calculation;
responses must echo that ledger and be validated. This prevents a soft latest
read from being combined with a different validated head.

Unknown submission outcomes remain `submitted`/pending and are reconciled by
the exact durable hash and explicit inclusion range. They are never replayed,
re-signed, or resubmitted.

## Owner approval preflight

V2 owner approvals require the authenticated local operation
`tx.approvalPreflight` immediately before Pilot calls `wallet.signOnly`.

Request:

```json
{
  "approval_id": "approval-id",
  "execution_contract": "xrpl_execution_v2",
  "build_revision": 1,
  "unsigned_tx_digest": "64 uppercase hex characters",
  "economic_fingerprint": "64 uppercase hex characters"
}
```

Response:

```json
{
  "status": "ready",
  "approval_id": "approval-id",
  "expires_at": "RFC 3339 UTC timestamp",
  "validated_ledger": 6200056,
  "remaining_ledgers": 8,
  "execution_capability": "the exact stored v2 capability object"
}
```

The operation is authorized by the existing principal and exact reviewed local
profile, not by a caller header, Origin, or loopback alone. It verifies exact
contract/revision/digests, `now < expires_at`, at least eight remaining ledgers,
owner Sequence, fee/load viability, and the optional acquisition balance
invariant. Its atomic `pending -> preflighted` approval transition freezes the
exact stored revision. V2 `tx.submit` accepts only a preflighted approval
and requires the same `execution_contract`, `build_revision`,
`unsigned_tx_digest`, and `economic_fingerprint`. V1 rejects those v2 fields.

Preflight is deliberately not replay-successful. The first successful call
atomically changes `pending` to `preflighted` and returns `status: "ready"`.
Any later or concurrently losing call returns the typed
`APPROVAL_ALREADY_PREFLIGHTED` error before a second authorization, but only
while `now < expires_at`. At or after the wall deadline `APPROVAL_EXPIRED`
takes precedence for both `pending` and `preflighted` approvals. Expiry alone
does not prove that no prior authorization occurred: a `preflighted` tuple can
represent a lost successful preflight response and remains frozen until the
reconciliation proof below burns it. A definitive validation rejection that
wins while the approval is still pending is stored as one immutable terminal
outcome; it cannot race into later authorization or submission.

## Expired unsigned approval reconciliation

The local trading profile exposes `tx.approvalReconcile` only for an official
Testnet RLUSD acquisition whose v2 preflight succeeded but whose response may
have been lost. The operation never signs, submits, resubmits, or authorizes a
transaction. It can only prove that the old tuple was not used, atomically burn
that tuple, and direct Pilot to request a fresh build.

Request:

```json
{
  "approval_id": "approval-id",
  "execution_contract": "xrpl_execution_v2",
  "build_revision": 1,
  "unsigned_tx_digest": "64 uppercase hex characters",
  "economic_fingerprint": "64 uppercase hex characters"
}
```

Terminal success:

```json
{
  "status": "expired_nonincluded",
  "approval_id": "approval-id",
  "execution_id": "execution-id",
  "validated_ledger": 6200065,
  "first_inclusion_ledger": 6200001,
  "last_ledger_sequence": 6200064,
  "next_action": "request_fresh_build"
}
```

Harbor binds the request through the authenticated principal to the exact
approval, execution, snapshot, and immutable build revision. Eligibility
requires the approval still be `preflighted`, its wall deadline be expired,
the execution still be hashless and unsigned in `needs_approval`, no relay
claim or preflight rejection, and only the original nonterminal
`needs_approval` result placeholder.

Harbor then establishes a validated head strictly greater than the immutable
`last_ledger_sequence`. At that exact head it requires the owner Sequence and
official Testnet RLUSD balance to equal the snapshot. It scans `account_tx`
from the exact inclusive `first_inclusion_ledger` through
`last_ledger_sequence`, with forward pagination, and accepts absence only after
the real marker is exhausted. Every page must echo the exact owner and bounds;
every returned entry must be validated, well formed, and within the immutable
window. A validated transaction by the owner with the snapshot Sequence is a
conflict. `searched_all` and a single soft `txnNotFound` are not used by this
proof.

The successful proof is committed in one D1 statement whose triggers
irreversibly set the approval to `expired`, the hashless execution to `failed`,
and the result to `APPROVAL_RECOVERED_NONINCLUSION`. The old build tuple can
never create another execution. A retry of the exact same five-field request
replays the identical stored success, including the same execution ID, ledger
bounds, and validated proof ledger, without another XRPL read. Any different
binding fails closed. Fresh work requires a new `tx.swap` and therefore a new
`build_id`; no revision is synthesized and no old transaction is replayed.

## Error codes

- `EXECUTION_CONTRACT_UNSUPPORTED`: v2 was requested outside its exact local
  profile, or an unknown contract was requested.
- `EXECUTION_CONTRACT_MISMATCH`: build, execute request, approval, or snapshot
  contract identifiers disagree.
- `EXECUTION_SNAPSHOT_STALE`: build revision or canonical binding changed
  before the atomic claim.
- `EXECUTION_SNAPSHOT_INVALID`: required v2 snapshot evidence is missing,
  partial, malformed, or inconsistent.
- `TRANSACTION_WINDOW_TOO_SHORT`: fewer than 8 ledgers remain at delegated
  signing or first relay.
- `APPROVAL_EXPIRED`: the 90-second wall deadline has passed.
- `QUOTE_EXPIRED`: a market quote was more than one ledger old when its build
  was constructed.
- `FEE_LOAD_UNSAFE`: the current open-ledger fee exceeds the immutable fee.
- `ACCOUNT_SEQUENCE_CHANGED`: the current owner Sequence no longer equals the
  immutable transaction Sequence.
- `BALANCE_INVARIANT_CHANGED`: the official-RLUSD issued balance differs from
  the exact validated pre-build balance.
- `APPROVAL_PREFLIGHT_REQUIRED`: a v2 signed blob arrived before the required
  authenticated preflight.
- `APPROVAL_ALREADY_PREFLIGHTED`: this approval already crossed the one-time
  preflight authorization boundary; treat a lost first response as ambiguous
  and freeze rather than refreshing or signing again.
- `APPROVAL_INVALIDATED`: Harbor encountered an approval already marked
  invalidated. Fresh replacement builds do not produce this state in the
  current contract.
- `APPROVAL_RECOVERY_NOT_READY`: the approval wall deadline or validated ledger
  head has not advanced far enough to begin terminal non-inclusion proof.
- `APPROVAL_RECOVERY_STATE_CHANGED`: exact-head owner Sequence or official
  Testnet RLUSD balance differs from the immutable snapshot.
- `APPROVAL_RECOVERY_INCOMPLETE`: exact-head state, bounded range pages,
  pagination exhaustion, or the durable terminal record is missing, malformed,
  partial, or unvalidated.
- `APPROVAL_RECOVERY_CONFLICT`: another authorization, submission, relay,
  transaction consuming the owner Sequence, terminal state, or different
  immutable request binding prevents recovery.
- `APPROVAL_TRANSACTION_MISMATCH`: the signed owner blob does not exactly match
  the approved transaction.
- `RELAY_ALREADY_ATTEMPTED`: the insert-only relay claim already exists; Harbor
  will reconcile by hash and will not relay again.
- `SUBMISSION_PENDING`: the first relay outcome is ambiguous; the reservation
  and hash remain pending for read-only reconciliation.

Operational note, not a protocol rule: the previously expired transaction hash
`27818E2D6B938511D3F948F1B05AA85354DEF4883F2072743A8EC65E2676D38A` is
non-retryable and must not be used as a v2 input or replay candidate.
