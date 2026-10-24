# Local autonomy Testnet v1 acceptance profile

This profile is a local-only Harbor runtime for controlled XRPL Testnet acceptance. It is separate from every preserved local trading and x402 state, uses its own D1 identity and loopback origin, and applies the canonical migration history (`migrations/`, including `0011_autonomous_strategies.sql` and `0014_declarative_strategies.sql`). It has no deployment or remote-D1 path.

## Fixed safety boundary

- Origin: `http://127.0.0.3:8793`
- State: `/absolute/private/pilot/harbor-state/harbor-autonomy-testnet-v1`
- Network: XRPL Testnet only; `MAINNET_EXECUTION=false`
- Authentication: required; legacy loopback auth bypass is disabled
- x402: disabled
- Runner: disabled in checked-in configuration
- Scheduler: local Wrangler test endpoint only; the runner is enabled only by the launcher's exact `--enable-runner` flag
- Evidence: bounded, credential-scrubbed JSON created exclusively under the profile's `evidence/` directory

The launcher refuses remote/deploy/publish/tunnel flags, altered profiles, partial migrations, reused or unmarked state, unsafe permissions, inherited credentials, and credentials in process arguments.

## Credential file prerequisite

Create the following file without printing its contents:

`/absolute/private/pilot/harbor-state/harbor-autonomy-testnet-v1/credentials.env.local`

It must be owned by the current user, mode `0600` (or `0400`), contain exactly one non-`local-dev` bearer and one 32-byte base64 KEK, and have this shape:

```text
HARBOR_API_KEYS=<principal>:<32-to-128-character-token>
HARBOR_KEK=<32-byte-base64-value>
```

The launcher creates and marks the state directory, but deliberately does not generate credentials. Do not put owner seeds, wallet secrets, sponsor credentials, or mainnet material in this file.

## Launch and one bounded scheduler tick

Default-off validation/runtime launch:

```sh
node scripts/dev-local-autonomy-testnet-v1.mjs
```

Explicit acceptance launch with the Testnet strategy runner enabled:

```sh
node scripts/dev-local-autonomy-testnet-v1.mjs --enable-runner
```

After a strategy has been created and approved through the product's real owner-wallet proof flow, capture one tick:

```sh
node scripts/run-local-autonomy-testnet-v1-tick.mjs --acceptance-id=<unique-id> --owner=<testnet-classic-address> --strategy-id=<strategy-id>
```

The tick harness reads owner-scoped strategy, audit, and account status before and after exactly one local scheduled event. It does not fund an account, create or authorize a strategy, sign anything, or call a faucet. The output omits authorization, signatures, transaction blobs, secrets, tokens, private material, and key-like fields while retaining public plan/digest/status/audit/transaction-hash evidence.

## Capability-to-ledger acceptance matrix

| Product path | Bounded Testnet scenario | Required evidence | Status before ledger run |
|---|---|---|---|
| One-time transaction | Existing intent/policy/signature flow; one approved transaction only, no strategy schedule | exact transaction hash, validated result, policy decision, balances before/after | Separate existing path; not executed by this harness |
| Recurring fixed buy | Declarative `always` condition plus fixed buy action, interval, expiry, cooldown, finite budgets and owner-approved `max_mandate_occurrences` | plan/mandate digest, exact executed-action occurrence count, cumulative usage, validated hashes, stop proof | Engine and local evidence harness ready; ledger not run |
| Scheduled fixed buy / DCA | One small fixed action, one scheduler tick, short expiry | quote timestamp, decision ID, policy/budget reservation, validated hash, balance delta | Harness ready; ledger not run |
| Price-threshold buy | Threshold condition with fresh indicative price; executable quote still must pass spread/slippage/liquidity limits | observed price source/time, quote source/time, condition outcome, execution or clear no-op reason | Harness ready; ledger not run |
| Price-threshold sell | Threshold condition with explicit sell direction and same fresh-quote gates | same as threshold buy plus correct input/output asset direction | Harness ready; ledger not run |
| Drift rebalance | Existing v1 semantics or declarative rebalance, one action per evaluation | balances/targets, drift calculation, selected action, reserve/exposure checks, validated hash | Harness ready; ledger not run |
| Pause / stop / kill | Trigger a tick after each lifecycle transition | no new decision/submission after transition; audit event and status | Harness ready; ledger not run |
| Revocation | Revoke the Testnet delegation then tick | revocation status, fail-closed audit/no submission | Harness ready; ledger not run |
| Unsupported/model-injected proposal | URL/script/unknown asset/action, excessive depth/size, authority expansion | deterministic validation rejection; no strategy authorization or ledger submission | Offline engine tests cover; repeat against local runtime |

For real acceptance, use disposable Testnet accounts and the repository's exact XRP/test-RLUSD allowlist. A conservative scenario budget is: at most 1 XRP-equivalent input per order, 2 orders per day, 3 orders lifetime, 0.1 XRP cumulative fee ceiling, 30-minute mandate expiry, at least a five-minute cooldown, and the existing reserve/liquidity/slippage limits. Those bounds are scenario guidance, not a runtime override; the actual canonical mandate must bind them.

Cleanup is an owner-visible lifecycle action, not state deletion: pause, stop/kill as applicable, revoke the Testnet delegation, trigger one final tick to prove fail-closed behavior, and retain the scrubbed evidence. Do not delete preserved local states or use this profile with mainnet.

## Recurring occurrence semantics

Finite recurring mandates bind `max_mandate_occurrences` in the owner-approved
limits. It counts execution actions reserved under that exact mandate, not
trigger evaluations. A retry or restart with the same decision does not double
count; submitted and ambiguous outcomes remain charged. Only a definitively
pre-submission abandonment or ledger-proven not-included outcome frees an
occurrence. The independent `max_total_trades` limit remains an
owner/network/asset lifetime cap and cannot be reset with a new strategy,
principal, mandate version, or process restart.
