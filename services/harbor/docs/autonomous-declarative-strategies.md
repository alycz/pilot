# Declarative autonomous strategies

This document defines the source-only, offline/mock acceptance boundary for
`declarative_strategy_v1`. It does not enable the scheduler, deploy Harbor,
create a grant, sign a transaction, submit to Testnet, or claim ledger
acceptance. The existing `xrp_issued_rebalancer_v1` contract remains supported
without reinterpretation.

## Supported capability grammar

The engine accepts a versioned, typed plan rather than model-authored code. A
plan is an ordered, finite list of rules. The first matching rule produces at
most one action for an evaluation; no rule can jump, loop, recurse, invoke a
URL, load a module, or emit a new plan.

| Primitive | Supported form | Bound |
| --- | --- | --- |
| Trigger | Validated interval tick | One trigger; 300–86,400 seconds |
| Finite recurring authority | Owner-approved executed-action occurrences | `max_mandate_occurrences`; 1–100,000, no greater than the lifetime trade cap |
| Rule graph | Ordered first-match rules | At most 8 rules |
| Rule condition set | Flat `all` list | At most 8 conditions; no nesting |
| Condition | `always` | Explicit unconditional match |
| Condition | Executable XRP price threshold | Canonical test-RLUSD per XRP; `bid` or `ask`; reviewed comparison operators only |
| Condition | XRP allocation outside a band | Integer basis points with target strictly inside the band |
| Action | Fixed-value XRP buy or sell | One fill-or-kill `OfferCreate` through the existing `tx.swap` operation |
| Action | Target-allocation rebalance | One bounded correction through the same `tx.swap` operation |
| Assets | XRP and exact Testnet RLUSD | Currency `524C555344000000000000000000000000000000`; issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` only |
| Network | XRPL Testnet | Mainnet, Devnet, bridges, sponsor rails, and perps are unsupported |

The fixed-value form covers scheduled buys/DCA when paired with `always`, and
price-threshold buy/sell rules when paired with the executable-price condition.
These are software behavior examples, not investment advice or promises of
profitability.

Unknown keys, assets, issuers, networks, venues, actions, condition kinds,
nested condition groups, scripts, URLs, callbacks, data-source requests,
noncanonical decimals, unsafe integer ranges, oversized plans, and ambiguous
instructions reject before a draft can become approvable. Extensibility is by
reviewed primitive registration and a new contract version, never runtime code
loading.

## Authority and digest boundary

Agent prose is untrusted proposal input. It has no signing, policy, grant,
activation, or execution authority. Deterministic compilation produces a
canonical plan and diagnostics. The mandate digest binds, at minimum:

- contract and execution-semantics version;
- exact owner, Testnet account, XRP and test-RLUSD issuer;
- ordered trigger, rule, condition, and action bytes;
- start and expiry times;
- per-order, daily, cumulative value, fee, exposure, trade-count, optional
  mandate occurrence count, cooldown, slippage, reserve, liquidity, quote-age,
  and ledger-gap limits; and
- the fixed fill-or-kill execution mode.

Owner approval binds that exact immutable digest and mandate version. Learning,
memory, and model output may propose a replacement draft but cannot mutate an
approved mandate. Any material plan, semantic-version, asset, or limit change
requires a new digest and owner approval.

The old rebalancer remains its original contract kind. Migration means either
continuing the old version unchanged or creating and approving a new
`declarative_strategy_v1` mandate; Harbor never silently translates an active
legacy mandate.

## Evaluation and execution boundary

Compilation, validation, and paper preview are deterministic. Every evaluation
receives explicit time, balances, reserve facts, validated-ledger index,
bid/ask, executable liquidity, fee, quote timestamp, current policy/grant
state, prior trade time, and durable budget counters. Missing, future,
contradictory, unvalidated, stale, or out-of-scope observations hold or reject;
the engine does not fabricate a market signal or fill.

Paper preview reports rule matching, proposed action, bounded notional, and
policy holds against supplied snapshots. It does not compute historical return,
use future data, predict fills, or claim transaction inclusion. Real ledger
acceptance remains distinct and is outside this source task.

An accepted action still traverses the existing builder, simulation, policy,
atomic quota reservation, durable idempotency receipt, account-wide sequence
lease, delegated signing, relay, reconciliation, watcher, and audit paths.
Manual, strategy, x402, and AP4M producers share the same account sequence
authority. A signed/submitted/ambiguous lease is never released by elapsed wall
time. Pause, stop, kill, mandate revocation, grant loss, expiry, policy change,
or lost fencing blocks new submissions; an uncertain prior submission remains
visible until reconciled.

The account-wide emergency kill is backed by an append-only owner/network
scope binding. One authenticated principal may hold that account's strategy
authority in a Harbor database. Migration refuses legacy cross-principal
conflicts, and runtime conflict detection keeps kill enabled and blocks
activation, resume, and submission fencing. It does not let one principal
clear another principal's control.

When present, `max_mandate_occurrences` is a finite count of reserved execution
actions under one exact approved mandate, not scheduler evaluations. The count
is reserved atomically with value, fee, and account-global trade budgets. A
retry with the same decision ID cannot consume it twice. Submitted or ambiguous
outcomes remain charged; only a definitively pre-submission abandonment or
ledger-proven not-included outcome frees an occurrence. New mandate versions
receive their own explicitly approved count, while owner/network/asset lifetime
budgets continue across strategies, principals, versions, and restarts.

Newly finalized exact-rail AP4M purchases may return
`ap4m-public-evidence-v1`: the exact server-built McIntent plus five bounded
digest references for the L1, merchant-selective L2, L3a, L3b, and validated
XRPL Payment. These are references, not exported signatures or credentials;
raw VI presentations, disclosures, signed transaction blobs, and key material
remain internal. Pay-channel purchases and historical rows do not synthesize
this evidence.

## Persistence and defaults

The plan is stored as canonical immutable mandate data. Proposals, approved
versions, triggers, decisions, reservations, executions, outcomes, and audit
events remain principal/account/network scoped. The additive migration may add
columns or tables required for cumulative and trade-count accounting, but no
existing migration file may change. Canonical and isolated-profile histories
must receive byte-identical additive migration source when that profile owns the
strategy runtime.

The global strategy kill state remains fail-closed and scheduler/live defaults
remain off. No new cloud resource, credential, owner key path, execution grant,
chain, venue, or dynamic-code surface is introduced.

## Evidence lanes

The required acceptance for this slice is contract/hash parity, deterministic
compiler/interpreter tests, property and adversarial tests, store/runner crash
and concurrency tests, migration-history validation, complete offline suites,
Pilot production build, and credential-scrubbed fixture browser coverage.
Those lanes do not prove Testnet submission, wallet signature acceptance,
Cloudflare/D1 behavior, deployment, or profitability.
