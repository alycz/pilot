# Autonomous Testnet rebalancer

## Capability boundary

Harbor contains a deterministic, bounded portfolio rebalancer for one XRPL
Testnet account and one exact XRP/issued-currency pair. It is implementation
ready for offline and mocked testing only. This change does not activate a
wallet, submit a transaction, configure a deployed Worker, or claim that live
Testnet acceptance has passed.

The first pair is XRP and the official test-RLUSD issue:

- network: `testnet`
- currency: `524C555344000000000000000000000000000000`
- issuer: `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`

The illustrative draft targets 50% XRP by value, holds while XRP remains in a
45–55% band, and evaluates no more often than every five minutes. Those values
are not wallet authority. Every active strategy must have its own immutable,
versioned, expiring owner-approved mandate.

No model chooses trades, changes permissions, widens limits, or activates the
strategy. Harbor never receives or stores an owner seed, private key, or
mnemonic. The feature makes no expected-return claim.

## Smallest deployment shape

The durable scheduler is an extension of Harbor's existing scheduled Worker,
not a new cloud resource. The existing foreign-delegate watchdog runs first.
The strategy scheduler is fail-closed unless `AUTONOMOUS_STRATEGY_RUNNER` is
explicitly `true`, the execution network is exactly `testnet`, mainnet
execution remains disabled, the account-level kill switch is clear, and the
strategy has an active current mandate. No deployment configuration is changed
by this feature.

One scheduled evaluation follows this path:

1. Claim a due schedule with a single-flight lease and fencing token.
2. Reconcile any unresolved prior execution before considering new work.
3. Read validated balances, reserve data, grant and policy state, and fresh
   executable bid/ask liquidity for the exact issue.
4. Run the fixed-point decision engine. A hold is persisted and explained when
   any input or safety condition fails.
5. Atomically reserve the proposed order value against the daily mandate cap.
6. Build an exact-output fill-or-kill swap through Harbor, simulate it, and
   apply the existing policy and delegated-signing gates.
7. Revalidate the mandate, authorization, grant, policy, kill state, lease, fee
   cap, and unresolved-execution state immediately before submission.
8. Persist execution identity before submission. An unknown outcome blocks all
   follow-up orders until read-only reconciliation proves validation or complete
   non-inclusion.

Only read-only observation and reconciliation calls have bounded retry. A
build, reservation, signing attempt, or submission is never retried as a new
trade.

## Mandate and limits

An active mandate binds all of the following:

- exact Testnet account, 40-hex currency, and issuer;
- target and lower/upper allocation basis points;
- minimum and maximum order value and maximum daily value;
- maximum fee in drops, slippage, and price impact;
- minimum XRP reserve plus a separate fee buffer;
- maximum XRP and issued-asset exposure;
- minimum executable liquidity;
- cooldown, quote freshness, and validated-ledger-gap limits;
- five-minute-or-longer schedule, fill-or-kill mode, start time, and expiry.

Canonical decimal strings and integer/fixed-point arithmetic are used for
valuation, sizing, exposure checks, and conservative daily budget reservation.
The engine does not assume the issued asset is worth one dollar: it uses fresh
executable bid/ask evidence, checks spread and liquidity, and fails closed on
missing, stale, malformed, contradictory, or wrong-issue observations.

The engine holds on an inside-band allocation, cooldown, minimum-trade floor,
reserve or exposure boundary, fee or daily cap, stale quote, weak liquidity,
inactive grant, paused policy, expired mandate, kill switch, or unresolved
submission. Normal `needs_approval` is recorded and pauses unattended work; it
never causes Harbor to sign as the owner.

## Durable state and concurrency

Strategy mandates, lifecycle, schedules, fenced leases, triggers, decisions,
budget reservations, executions, control receipts, and audit events are stored
in D1. Trigger, decision, execution, and execution-idempotency identities are
stable functions of the schedule and mandate rather than worker process state.
Pending and ambiguous executions continue to count against budgets.

Within one authoritative D1 database, the sequence coordinator is global at
the XRPL ledger boundary: its unique key is `(network, account)`. Principal,
wallet session, and producer are audit and authorization metadata only; they do
not partition serialization. Manual `tx.execute`, owner-approval relay,
strategy execution, AP4M, and x402 signing paths all acquire this authority
before signing or submission. Isolated profiles intentionally use separate D1
databases, so deployment must keep their configured payer accounts distinct;
the same XRPL account must never be active in two separate authorities.
Signed, submitted, or ambiguous leases do not expire by wall clock. They are
released only for a matching validated terminal result or exhaustive validated
ledger-window non-inclusion evidence.

## Lifecycle and controls

The visible lifecycle is `draft`, `active`, `paused`, `stopped`, or `error`.
Creation saves a draft and cannot trade. Activation and resume require a fresh
wallet proof bound to the exact account, network, strategy ID, mandate version,
mandate digest, mandate expiry, action, and stable request ID. Configuration is
immutable while active; a changed value creates a new draft version.

Pause blocks new evaluations. Stop and per-strategy emergency kill block new
submissions for that strategy. The account-level kill switch blocks all of that
owner's strategies and is fail-closed when it has not been initialized. None of
these controls promises to cancel a ledger transaction already signed,
submitted, or of unknown outcome. Unresolved identity and budget state remain
visible and reserved until reconciliation.

## Verification requirements

Run the focused engine, store, runner, adapter, operation, cron, sequence,
cross-producer, and x402 suites from the destination. Then run its complete
typecheck and offline CI. Those checks do not prove wallet signing, Testnet
submission, funding, deployment, or scheduler activation.
its own exact-head hosted CI before it can be used. Passing source checks are
not live Testnet acceptance.

Intentionally not run: live Testnet signing or submission, faucet use, grant or
revocation, provider calls, owner-key access, mainnet execution, deployment, or
cloud scheduler/resource creation.
