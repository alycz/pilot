# Declarative autonomous strategy UX

This document defines Pilot's source-only, offline/mock product boundary for
`declarative_strategy_v1`. It does not enable trading, request a real wallet
signature, deploy Pilot, submit to Testnet, or claim ledger acceptance. The
signed-out illustrative rebalancer remains a separate client-only demo with no
authentication or wallet calls.

## Proposal and review flow

Pilot presents a bounded capability editor rather than an "any strategy"
promise:

1. The existing model/tool path may propose a typed draft. Model text remains
   untrusted and cannot sign, approve, activate, execute, or choose an
   unregistered primitive.
2. The authenticated editor applies an exact local shape check for immediate
   field errors; Harbor independently compiles and validates the proposal on
   `create`. The agent/mock path also exposes the non-authorizing Harbor
   `validate` operation directly. Rejection covers unknown assets, issuers,
   networks, venues, actions, data sources, scripts, URLs, nested/unbounded
   rules, malformed values, and ambiguous instructions.
3. The editor's deterministic paper preview explains which ordered rule would
   match the user's explicit timestamp, executable bid/ask, and allocation
   inputs. It does not invent ledger balances or market data and is not a
   backtest, forecast, fill, return calculation, or ledger-acceptance result.
   The agent/mock path separately exercises Harbor's server-side `simulate`
   operation with a complete trusted fixture observation.
4. The owner reviews plain-language rules, exact canonical plan, all limits,
   account, network, assets, semantics version, expiry, and digest, then signs
   one proof for that immutable mandate.
5. Inside the approved mandate, later evaluations need no per-trade prompt but
   still pass Harbor policy, quota, reserve, liquidity, freshness, grant,
   sequence, and reconciliation checks.

Editing any risk-bearing field creates a new draft/version and requires a new
owner proof. Preferences, lessons, memory, model messages, and paper results
can suggest a revision but cannot change approved authority.

## Capability disclosure

| Goal | Exact expression |
| --- | --- |
| Drift rebalance | Interval trigger plus an XRP allocation-band condition and bounded target-allocation action |
| Scheduled fixed buy / DCA | Interval trigger plus `always` and a fixed test-RLUSD-value XRP buy |
| Price-threshold buy | Interval trigger plus executable `ask` comparison and a fixed-value XRP buy |
| Price-threshold sell | Interval trigger plus executable `bid` comparison and a fixed-value XRP sell |

New recurring and autonomous proposals also bind an explicit immutable-mandate
action count. It counts reserved, committed, and outcome-unknown execution
actions, not scheduler evaluations. A retry with the same decision identity is
counted once. A new approved mandate version gets a newly reviewed count, while
the independent owner/network/asset lifetime trade and value caps continue
across versions, strategies, principals, reloads, and restarts.

Plans are limited to one interval trigger, at most eight ordered first-match
rules, at most eight flat `all` conditions per rule, and at most one action per
matched rule. Supported trading is XRPL Testnet only and is restricted to XRP
and test-RLUSD currency
`524C555344000000000000000000000000000000` issued by
`rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`. Execution uses Harbor's existing
fill-or-kill swap primitive. Other assets, issuers, networks, venues, bridges,
payments, LP/vault actions, perps, arbitrary data feeds, code, URLs, and
recursive graphs are not supported by this version.

## Required surfaces and states

The authenticated autonomous section exposes:

- proposal source and structured editing without treating prose as authority;
- supported-capability disclosure and unsupported diagnostics;
- canonical rules and exact per-order, daily, cumulative, fee, exposure,
  trade-count, immutable-mandate occurrence, expiry, cooldown, slippage,
  reserve, liquidity, quote-age, and ledger-gap limits;
- local deterministic validation and paper-preview evidence with explicit
  timestamps, executable price side, allocation, and fixed-point precision;
- server-side validation on draft creation, plus explicit Harbor
  validation/simulation results in the agent/mock flow when a complete trusted
  observation (including ledger index, balances, reserve, and policy inputs)
  is available;
- immutable approval summary with owner/account/network/assets/version/digest;
- draft, pending approval, active, paused, stopped, killed, revoked, expired,
  error, and unresolved-submission states;
- cancel/reject/reload and unknown-outcome recovery that reuses the original
  request identity rather than sending a replacement mutation;
- account-switch isolation; and
- a transparent decision timeline linking trigger, decision, reservation,
  build, execution, reconciliation, and transaction identities.

Pause, stop, kill, and revoke block new submissions. They do not claim to
cancel an already signed, submitted, or ambiguous transaction. The UI keeps an
unresolved action visible and offers read-only reconciliation. Kill remains
available when safe even if another control outcome is unknown.

Harbor enforces one authenticated principal for each owner/network strategy
authority domain. Pilot therefore describes emergency kill as account-wide
only under that fail-closed owner binding; it never suggests that one account
session can clear another session's control.

For a newly finalized exact-rail AP4M purchase, Pilot may render the strict
server-owned `ap4m-public-evidence-v1` bundle: the exact McIntent and five
digest references (L1, merchant-selective L2, L3a, L3b, and the validated XRPL
Payment hash). These references are not signatures. Raw VI presentations,
disclosures, signed blobs, credentials, and key material are never exported.
Pay-channel and historical results without this bundle do not get a live
evidence card.

The section retains accessible labels, keyboard/focus behavior, mobile layout,
and reduced-motion behavior. It must say Testnet and default off wherever the
execution boundary could otherwise be misunderstood.

## Contract and base coordination

Pilot's contract package is an exact byte copy of Harbor's source contract.
Any declarative-plan contract change requires the synchronized source bytes,
Pilot's contract package is an exact byte copy of Harbor's source contract.
Any declarative-plan contract change requires synchronized bytes, a new
CONTRACT_HASH, client operation inventory, and mock/browser fixtures in the same
reviewed destination change.
## Evidence lanes

Unit tests prove parsing, state, and rendering against deterministic inputs.
Mock-client tests prove the complete proposal, Harbor validation, Harbor paper
simulation, draft, mock owner authorization, and separately bounded mock trade
flow without a provider call. Fixture browser tests prove signed-out separation,
authenticated draft/control behavior, reload/account-switch handling, mobile
layout, and reduced motion; they do not claim a browser-level declarative trade.
A production build proves bundling only. None of those proves a wallet
signature, Testnet inclusion, Harbor/D1 deployment, real market freshness, or
profitability.
