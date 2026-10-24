# Autonomous Testnet rebalancer

Pilot provides the owner-facing control plane for Harbor's deterministic,
bounded XRP/test-RLUSD rebalancer. The feature is built for XRPL Testnet and
test funds only. It is not activated by this change, has not completed live
bounded Testnet acceptance, and makes no expected-return claim.

## Exact scope

The first strategy supports one connected Testnet account and one exact issue:

- XRP;
- currency `524C555344000000000000000000000000000000`;
- issuer `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`.

The illustrative form defaults to a 50% XRP target, a 45–55% XRP band, and a
five-minute evaluation interval. A user must also choose and validate maximum
order and daily values, minimum order, fee, slippage, price-impact, reserve,
fee-buffer, exposure, liquidity, cooldown, quote-age, and expiry bounds. Saving
the form creates a draft and cannot trade.

## Owner authorization

Activation and resume use a strategy-specific sign-only wallet challenge. It is
separate from chat and login proofs and binds the exact Testnet account,
strategy ID, action, mandate version, mandate digest, mandate expiry, stable
request ID, and short-lived nonce. Pilot never receives an owner key and the
wallet does not submit this proof to XRPL.

The mandate authorization may last only until its approved mandate expiry; the
challenge itself expires quickly. Replaying the same signed request ID can only
replay the same durable Harbor control receipt. A proof cannot be moved to a
different request ID, action, account, version, digest, expiry, or network.
Unknown mutation outcomes keep their request ID visible and require status
refresh before another action.

Pilot's dedicated `/api/strategy/[action]` surface:

- requires a wallet-bound Testnet session and exact same-origin request;
- derives account and network on the server and rejects client-supplied scope;
- validates bounded JSON and an allowlist of owner operations;
- does not expose runner ticks, leases, reconciliation, or the shared-principal
  Harbor global control;
- forwards stable request IDs and validates returned owner/Testnet scope.

## User-visible behavior

The strategy page labels every state as XRPL Testnet and test funds. It displays
the exact issue, immutable mandate digest and version, lifecycle, schedule,
limits, latest explainable holds, unresolved transaction warning, and decision
and transaction audit trail.

The lifecycle is `draft`, `active`, `paused`, `stopped`, or `error`:

- **Pause** blocks new evaluations.
- **Resume** revalidates the unchanged mandate with a fresh wallet proof.
- **Stop** terminally stops the current mandate version.
- **Emergency kill** blocks new submissions for this strategy.

Pause, stop, and kill do not promise immediate ledger cancellation. A signed,
submitted, or uncertain transaction remains visible and blocks follow-up orders
until Harbor reconciliation proves its outcome.

## Runtime boundary

Pilot never schedules or executes a strategy itself. Harbor owns durable
schedules, single-flight leases, deterministic decisions, atomic budgets,
build/simulation/policy gates, delegated signing, account-global sequence
coordination, and reconciliation. Harbor's runner is disabled unless its
server-side feature flag is explicitly enabled; this repository does not change
that flag or any deployment configuration.

No chat model, model preference, memory, browser polling loop, or historical
transaction approval can expand a mandate. A normal `needs_approval` result is
shown as a hold and is not silently owner-signed.

## Verification evidence

The authoritative hosted evidence is the exact draft pull request head and its
## Verification requirements

Run the focused strategy, contract, client, proof, recovery, UI, and shell
suites from the destination. Then run its complete typecheck and fixture CI.
Those checks remain offline evidence only and do not prove wallet signing,
Testnet submission, provider calls, funding, deployment, or scheduler setup.
