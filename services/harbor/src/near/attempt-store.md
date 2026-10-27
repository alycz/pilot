# Hosted NEAR attempt persistence boundary

This module is persistence only. It does not request quotes, authorize a
principal, connect a wallet, sign, submit, deposit, broadcast, poll a provider,
or independently verify settlement.

Callers must first parse the shared Pilot v2 principal, approval, idempotency,
reservation, attempt, and reconciliation contracts and recompute their exact
digests. The adapter rejects changed persisted fields on idempotent replay, but
does not replace that upstream authorization or signature verification.

## Why the counter uses decimal text and CAS

Cloudflare D1 uses SQLite 64-bit signed integers and its Workers binding does
not accept `BigInt`. NEAR atomic amounts can exceed both ranges. The adapter
therefore validates canonical decimal strings up to 128 digits, performs exact
addition and subtraction with Worker `BigInt`, and submits the prior decimal
value, prior revision, and exact next decimal value to D1.

The schema's insert/release triggers update the counter only when both the prior
text value and revision match. The attempt mutation, counter CAS, and evidence
append occur in the same SQLite statement or D1 `batch()` transaction. A stale
Worker loses the CAS and rereads; no read-sum-await-insert sequence is treated
as atomic.

First admission checks authorization, approval, and provider deadlines against
the trusted Worker clock; caller timestamps cannot backdate a new reservation.
Exact idempotent replay remains readable after expiry. Reconciliation evidence
must move audit time forward and cannot claim a time later than that same
trusted clock.

The counter is scoped by tenant, principal, network, and asset. Wallet account
remains bound to each attempt but cannot create a fresh budget bucket.

References:

- <https://developers.cloudflare.com/d1/worker-api/d1-database/>
- <https://developers.cloudflare.com/d1/worker-api/>

## Acceptance boundary

Migration `0018_near_attempt_store.sql` is checked into the canonical and
Free/QuickJS reviewed migration profiles, but this change does not apply it.
No route or execution adapter instantiates this store. Remote migration apply,
backup/restore rehearsal, D1 remote multi-worker contention, observability,
retention, and provider/destination evidence acceptance remain separate gates.
