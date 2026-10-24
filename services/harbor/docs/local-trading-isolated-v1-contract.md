# Local wallet isolated v1 contract

This artifact freezes the only supported topology for the
`local-wallet-isolated-v1` Harbor preparation increment. It does not authorize
starting either service, creating credentials, funding, signing, publishing, or
deploying.

## Exact topology and profile literals

| Item | Exact value |
| --- | --- |
| Profile identifier | `local-wallet-isolated-v1` |
| Harbor origin | `http://127.0.0.2:8791` |
| Harbor health URL | `http://127.0.0.2:8791/health` |
| Pilot origin | `http://127.0.0.2:3003` |
| Harbor host | `127.0.0.2` |
| Harbor port | `8791` |
| Wrangler IP argument | `--ip 127.0.0.2` |
| Wrangler inspector IP argument | `--inspector-ip 127.0.0.2` |
| Wrangler config | `wrangler.local-trading-isolated-v1.jsonc` |
| Package script | `dev:local:trading:isolated:v1` |
| Launcher | `node scripts/dev-local-trading-isolated-v1.mjs` |
| Wrangler state | `.wrangler/harbor-local-trading-isolated-v1` |
| Wrangler log | `.wrangler/harbor-local-trading-isolated-v1/wrangler.log` |
| Local D1 name | `harbor-local-trading-isolated-v1-only` |
| Local D1 id | `22222222-2222-2222-2222-222222222222` |
| Frozen migration directory | `migrations-profile-trading-isolated-v1` |
| Credential file | `/absolute/private/pilot/harbor-secrets/harbor-local-trading-isolated-v1.env.local` |
| Runtime enablement marker | `HARBOR_LOCAL_TRADING_ISOLATED_V1_RUNTIME_ENABLED=true` |
| Signing-profile marker | `HARBOR_LOCAL_TRADING_ISOLATED_V1_SIGNING_PROFILE=local-wallet-isolated-v1` |
| Durable build origin | `local-trading-isolated-v1` |
| Network | `testnet` |
| Executor | `quickjs` |

## Exact sequential onboarding profile

The wallet lifecycle uses a second, mutually exclusive process profile. Its
exact literals are part of the Pilot integration contract:

| Item | Exact value |
| --- | --- |
| Profile identifier | `local-wallet-isolated-onboarding-v1` |
| Harbor origin | `http://127.0.0.2:8791` |
| Harbor health URL | `http://127.0.0.2:8791/health` |
| Wrangler config | `wrangler.local-trading-isolated-v1-onboarding.jsonc` |
| Package script | `dev:local:trading:isolated:v1:onboarding` |
| Launcher | `node scripts/dev-local-trading-isolated-v1-onboarding.mjs` |
| Shared Wrangler D1 state | `.wrangler/harbor-local-trading-isolated-v1` |
| Distinct Wrangler log | `.wrangler/harbor-local-trading-isolated-v1/onboarding.wrangler.log` |
| Shared local D1 name | `harbor-local-trading-isolated-v1-only` |
| Shared local D1 id | `22222222-2222-2222-2222-222222222222` |
| Shared frozen migration directory | `migrations-profile-trading-isolated-v1` |
| Shared credential file | `/absolute/private/pilot/harbor-secrets/harbor-local-trading-isolated-v1.env.local` |
| Runtime enablement marker | `HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_RUNTIME_ENABLED=true` |
| Signing-profile marker | `HARBOR_LOCAL_TRADING_ISOLATED_V1_ONBOARDING_SIGNING_PROFILE=local-wallet-isolated-onboarding-v1` |
| Durable build origin | `local-trading-isolated-onboarding-v1` |
| Network | `testnet` |
| Executor | `quickjs` |

The onboarding profile reuses exactly the existing reviewed onboarding
operation allowlist and adds nothing:

- `onboarding.readiness`
- `account.link`
- `account.status`
- `account.revoke`
- `ledger.account.info`
- `ledger.account.lines`
- `ledger.account.tx`
- `policy.get`
- `policy.set`
- `tx.trustSet`
- `tx.approvalPreflight`
- `tx.execute`
- `tx.submit`
- `tx.status`

`tx.swap` is excluded. The six-operation isolated trading allowlist remains
unchanged.

Onboarding and trading never run concurrently. Stop onboarding before starting
trading. Restart onboarding only for wallet lifecycle work, including
revocation, and stop it again before returning to trading. Sharing is limited
to the exact credential file and the exact local D1 persistence above; profile
markers, configs, launchers, logs, operation capabilities, and durable build
origins stay distinct. A build, execution, approval, direct-owner binding, or
recovery record created by one profile cannot be consumed as if created by the
other.

The launcher accepts no command-line arguments or configuration overrides. It
uses exactly the config, state, D1, log, credential path, host, inspector host,
and port above. The credential file is referenced and validated but is never
created by this increment.

## Frozen migration boundary

Both isolated launchers use only the dedicated frozen directory above. It
contains exactly the reviewed `0001` through `0006` migration set (including
both reviewed `0002` files), and every frozen file must remain a regular,
single-link, byte-identical copy of its canonical source in `migrations/` with
its reviewed SHA-256 digest. Both directories must remain stable, canonical
non-symlink directories; files are opened without following symlinks and their
descriptor identities are checked before and after reads. The profile is
revalidated after catalog generation and immediately before migration
application.
Missing, additional, linked, or byte-drifted files fail before preserved state
or credentials are read. Preserved D1 state must record that exact ordered
migration history; later shared migrations cannot be treated as part of this
profile. Shared and combined launchers retain their existing migration
directories and are not changed by this boundary.

## Request boundary

An isolated request is local only when its raw WHATWG-serialized origin is
exactly `http://127.0.0.2:8791`, its uncanonicalized `Host` header is exactly
`127.0.0.2:8791`, the isolated marker pair is present and exact, and any
browser fetch metadata is same-origin or absent. The legacy
`127.0.0.1`, `localhost`, `[::1]`, other ports, other `127/8` addresses,
alternate IPv4 spellings, user-info, fragments, and forwarded-host or
forwarded-proto chains do not establish this capability.

Harbor always requires the named bearer for this profile. The browser talks to
Pilot at `http://127.0.0.2:3003`; Pilot calls Harbor server-to-server. Browser
origins, CORS, forwarding headers, and the Pilot address never authorize direct
Harbor access.

## Capability boundary

The isolated profile reuses the existing reviewed local-trading operation
allowlist without adding operations:

- `tx.swap`
- `tx.approvalPreflight`
- `tx.approvalReconcile`
- `tx.execute`
- `tx.submit`
- `tx.status`

All execution-lifetime-v2 bindings, exact-output economics, policy, approval,
proof, replay, reservation, signing, and submission gates remain unchanged.
Only Testnet requests are accepted. Cron and x402 remain disabled.

The old read-only, x402, trading, and onboarding profiles are unchanged. Any
partial, malformed, or mixed combination of their markers, config paths, state
paths, D1 names, credential paths, build origins, or isolated markers fails
closed. There is no fallback topology.

## Preparation-only acceptance

Acceptance is limited to credential-free unit, contract, launcher-validation,
typecheck, and full regression tests. Tests must not listen on a socket. This
increment does not start or bind Harbor or Pilot, open a browser or wallet,
create or read the real credential file, create or mutate real D1 state, fund an
account, sign or submit a transaction, push, deploy, or alter a watched runtime
checkout.
