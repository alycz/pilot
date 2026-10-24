# Execution Service

Harbor is a policy-gated XRP Ledger gateway for agents and applications. It
runs on Cloudflare Workers, exposes the same operation registry through MCP and
REST, builds and simulates unsigned XRPL transactions, and can execute approved
Testnet or Devnet transactions through XRPL Permission Delegation without ever
accepting an owner seed.

The MCP surface stays deliberately small: `search` discovers operations and
their schemas; `execute` runs a bounded script against the typed `harbor.*`
namespace. REST integrations call the same guarded operations directly at
`POST /api/ops/{operation}`.

> **Current status**
>
> The repository has extensive offline unit, contract, migration, and lifecycle
> coverage. That is not a claim of hosted acceptance, production readiness, or
> successful live delegated execution. Startup of the isolated-v1
> `127.0.0.2` services is currently paused for an administrator-alias handoff;
> this hold does not describe the legacy `127.0.0.1` profiles. An older on-ledger
> delegation remains unresolved; revocation must not be described as complete
> until a validated ledger read proves it.

## What Harbor does

- Discovers XRPL execution primitives, venues, documentation, and local
  playbooks from one searchable catalog.
- Reads validated account, ledger, order-book, AMM, vault, token, lending,
  yield, and amendment state through bounded adapters.
- Builds, preflights, simulates, and stores unsigned transactions before any
  signing decision.
- Evaluates principal-scoped policy, atomically reserves daily USD allowance
  before delegated signing, and returns `execute`, `needs_approval`, or `block`.
- Custodies Harbor-generated operational signer material: delegate and x402
  payer seeds are AES-256-GCM wrapped at rest and can be unwrapped for only
  their guarded signing paths. Owner keys and the merchant receiver key remain
  outside Harbor.
- Persists idempotency claims, immutable execution snapshots, signed hashes,
  relay claims, and reconciliation evidence to prevent replay and silent
  transaction substitution.
- Watches hosted active links for foreign delegated transactions and suspends
  a link before preparing an unsigned owner revocation transaction.

Harbor does **not** execute on XRPL Mainnet, custody an owner key, promise best
execution, infer success from simulation, or treat process health as onboarding
readiness.

## Interfaces

### HTTP routes

| Route | Authentication | Purpose |
| --- | --- | --- |
| `GET /health` | none | Process health only; returns `handoff_readiness: "not_evaluated"` |
| `/mcp` | named bearer, except the narrow read-only local bypass | MCP Streamable HTTP with `search` and `execute` |
| `POST /api/ops/{operation}` | named bearer, except the narrow read-only local bypass | Direct invocation of one registered operation |
| `GET /local/x402/probe` | none; exact local x402 signing profiles only | Non-mutating fixed-target connectivity probe; not payment evidence |

Remote credentials use this header:

```text
Authorization: Bearer <principal>:<token>
```

The principal is part of the security boundary. Links, policies, builds,
approvals, executions, and event queries are scoped to it in D1.

### MCP

Search before calling an operation:

```json
{
  "query": "validated account balances and trust lines"
}
```

Then pass only a script to `execute`:

```js
const [info, lines] = await Promise.all([
  harbor.ledger.account.info({ account: "r...", network: "testnet" }),
  harbor.ledger.account.lines({ account: "r...", network: "testnet" })
]);
return { info, lines };
```

The script sandbox has no outbound network capability. It can call at most 30
Harbor operations, has a 10-second execution deadline, and returns at most
24 KiB of serialized output. The deployed runtime prefers a Dynamic Worker
when the Loader binding is available and otherwise falls back to QuickJS; the
same provider guards apply to both paths.

### REST

REST sends the operation arguments directly as JSON:

```bash
export HARBOR_URL='https://<your-harbor-worker>'
export HARBOR_API_KEY='<principal>:<token>'

curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer $HARBOR_API_KEY" \
  --header 'Content-Type: application/json' \
  --data '{"account":"r...","network":"testnet"}' \
  "$HARBOR_URL/api/ops/ledger.account.info"
```

REST requests and responses are capped at 1 MiB. Unknown operations return
HTTP 404; invalid or oversized JSON returns HTTP 400 or 413. Operation failures
normally return an error envelope, so clients must inspect `ok` rather than
assuming HTTP 200 means success.

### Response envelope

Successful operations return:

```json
{
  "ok": true,
  "data": {},
  "asOf": "2026-10-20T00:00:00.000Z",
  "asOfBasis": "server-time"
}
```

Failures return a redacted, stable shape:

```json
{
  "ok": false,
  "error": {
    "service": "tx.execute",
    "kind": "error",
    "message": "Operation failed",
    "code": "OPERATION_FAILED"
  }
}
```

Read `data` only when `ok` is `true`. Treat `soft-empty` as an explicit empty
upstream result, not a successful mutation.

## Verified operation catalog

The registry contains 47 operations. Registration does not imply universal
authority: local profiles reduce this surface, policy can block execution, and
network amendments or data availability can make an operation unavailable.

| Area | Operations |
| --- | --- |
| Account and onboarding | `account.link`, `account.status`, `account.revoke`, `onboarding.readiness` |
| Ledger and server | `ledger.account.info`, `ledger.account.lines`, `ledger.account.objects`, `ledger.account.tx`, `ledger.fee`, `server.reserves`, `amendments.status` |
| Market and protocol reads | `amm.info`, `amm.position`, `amm.pools`, `dex.book`, `dex.quote`, `dex.depth`, `vault.info`, `lending.brokers`, `perps.markets`, `yield.options` |
| Token and venue discovery | `tokens.lookup`, `tokens.trending`, `tokens.flagged`, `venues.list`, `venues.get`, `venues.compare`, `docs.search`, `skill.read` |
| Transaction builders | `tx.swap`, `tx.offer`, `tx.offerCancel`, `tx.payment`, `tx.trustSet`, `tx.ammDeposit`, `tx.ammWithdraw`, `tx.vaultDeposit`, `tx.vaultWithdraw`, `tx.simulate` |
| Policy and execution | `policy.get`, `policy.set`, `tx.execute`, `tx.approvalPreflight`, `tx.approvalReconcile`, `tx.submit`, `tx.status` |
| Local x402 | `x402.pay` |

Transaction builders return stored, unsigned `TxBuild` objects. `tx.swap`
supports `execution_mode: "immediate_or_cancel" | "fill_or_kill"`; omission
preserves IOC. Exact-output FOK uses validated `ripple_path_find` evidence,
exact decimal/integer ceiling, a short ledger window, and re-simulation before
execution. It is a bounded candidate quote, not a best-execution guarantee or
liquidity reservation.

## Architecture

```text
MCP client / REST client
          |
          v
Cloudflare Worker: route + bearer authentication
          |
          v
Principal-scoped operation context
          |
          +--> MCP search (catalog index)
          |
          +--> MCP execute --> Dynamic Worker or QuickJS sandbox --+
          |                                                   |
          +--> REST operation --------------------------------+
                                                              v
                                             shared Harbor provider guards
                                                              |
                                  +---------------------------+------------------+
                                  |                           |                  |
                                  v                           v                  v
                           operation registry          D1 durable state   bounded adapters
                                  |                      and policy       XRPL/docs/indexers
                                  v
                     builders / reads / execution lifecycle
```

| Component | Source of truth |
| --- | --- |
| Worker routes, authentication, profile selection | [`src/server.ts`](src/server.ts) |
| MCP `search` and `execute` | [`src/mcp/tools.ts`](src/mcp/tools.ts) |
| REST body/response bounds and shared invocation | [`src/rest.ts`](src/rest.ts) |
| Catalog and operation schemas | [`src/catalog/registry.ts`](src/catalog/registry.ts), [`src/ops/`](src/ops/) |
| Dynamic Worker / QuickJS sandbox | [`src/executor/run.ts`](src/executor/run.ts), [`src/executor/quickjs.ts`](src/executor/quickjs.ts) |
| Profile, network, and operation allowlists | [`src/executor/providers.ts`](src/executor/providers.ts) |
| Builds, policy, signing, execution, reconciliation | [`src/exec/`](src/exec/), [`src/ops/tx-exec.ts`](src/ops/tx-exec.ts) |
| D1 schema | [`migrations/`](migrations/) |
| Foreign-transaction watcher | [`src/exec/watcher.ts`](src/exec/watcher.ts), [`src/cron.ts`](src/cron.ts) |

The companion [diagram prompt pack](docs/diagram-prompts.md) contains
source-grounded prompts for editable architecture and lifecycle diagrams.

## Transaction lifecycle

### 1. Link an owner account

Use a separately funded Testnet or Devnet budget account, never a main-holdings
account. `account.link` creates or reuses a Harbor delegate, stores only its
AES-GCM-wrapped seed, and returns an unsigned owner `DelegateSet`.

```js
return await harbor.account.link({
  owner: "<BUDGET_ACCOUNT_CLASSIC_ADDRESS>",
  network: "testnet"
});
```

The reviewed permission list is:

1. `OfferCreate`
2. `OfferCancel`
3. `TrustSet`
4. `AMMDeposit`
5. `AMMWithdraw`
6. `EscrowFinish`
7. `CheckCash`

The owner reviews and signs the exact `DelegateSet`. In the reviewed local
trading modes, a direct Harbor relay is accepted only by the corresponding
onboarding profile, only for a transaction matching the stored
principal/owner/delegate/network/link state, and only with a durable origin
binding. This statement describes those local profiles, not a general hosted
provider contract. The link is usable only after `account.status` reports
`active` from validated ledger state.

### 2. Build and simulate

Call a transaction builder such as `tx.swap` or `tx.trustSet`. Harbor fills
fee, sequence, ledger bounds, source tag, and intent memo; performs preflight
checks; simulates the exact unsigned transaction; and persists the build.
Simulation never authorizes signing and never proves final execution.

### 3. Claim one intent and evaluate policy

Call `tx.execute` with one stable idempotency key:

```js
return await harbor.tx.execute({
  build_id: "<BUILD_ID>",
  idempotency_key: "<STABLE_UNIQUE_INTENT_KEY>",
  require_owner_approval: true
});
```

The key is bound to the principal, build, execution contract, revision, and
execution mode. A different retry fails closed. `require_owner_approval: true`
is a strict one-way choice: it cannot be converted to delegated execution by a
permissive or concurrently changed policy.

Policy checks include link state, network, transaction type, issuer and
RequireAuth facts, per-transaction USD value, slippage, and daily USD cap. For
delegated execution, Harbor atomically reserves the current daily allowance and
immutable execution snapshot **before** it unwraps the delegate for signing.

### 4. Execute or request owner approval

- `executed`: retain the validated hash and ledger index.
- `needs_approval`: stop and present the exact unsigned transaction, policy
  reasons, approval ID, and expiry to the owner.
- `blocked`: do not retry, split the request, weaken policy, or substitute a
  route.
- `failed`: report the final engine result without claiming execution.

The bounded local `xrpl_execution_v2` contract adds an immutable revision,
canonical transaction digest, economic fingerprint, exact inclusion window,
minimum remaining ledgers, 90-second owner approval TTL, and optional balance
invariant. See
[`docs/execution-lifetime-v2-contract.md`](docs/execution-lifetime-v2-contract.md).

V2 approvals require `tx.approvalPreflight` immediately before owner
sign-only. A submitted hash is durably claimed before the sole relay. Unknown
outcomes are reconciled against the exact hash and persisted inclusion window;
they are never blindly re-signed or resubmitted. The narrow
`tx.approvalReconcile` path can burn an expired, preflighted, provably
non-included official Testnet RLUSD acquisition tuple and direct the client to
request a fresh build.

### 5. Revoke safely

`account.revoke` immediately suspends Harbor's local link and returns an
unsigned empty-permission `DelegateSet`. Suspension is not on-ledger revocation.
The owner must sign the exact transaction, it must validate on the intended
test network, and `account.status` must report `revoked`. The currently
unresolved older delegation has not completed this proof.

The hosted minute cron scans active links for foreign delegated transactions.
It records evidence, suspends the link, and prepares an unsigned revocation;
it never signs with the owner key. Local trading profiles disable cron, so the
hosted watcher is not active there.

## Local development

### Install and run offline checks

Requirements: Node.js 24 or newer and npm.

```bash
cd services/harbor
npm ci
npm run typecheck
npm test
```

`npm test` is the reproducible offline suite. Smoke tests are separate and
require an explicitly selected running Worker.

### Credential-free read-only profile

```bash
npm run dev:local
```

This fixed launcher regenerates the catalog, applies only local migrations,
and binds Harbor to `http://127.0.0.1:8791`. It passes a sparse child
environment, uses local D1 state under `.wrangler/harbor-local`, disables
external mutation operations and cron, and does not load `.dev.vars` or a
production D1. Reads, builders, and simulations may still access public
Testnet endpoints when invoked; the test suite itself remains offline.

### Fixed local profiles

| Command | Address | External operation surface | State boundary |
| --- | --- | --- | --- |
| `npm run dev:local` | `127.0.0.1:8791` | Registry with external ledger mutations denied | `.wrangler/harbor-local` |
| `npm run dev:local:x402` | `127.0.0.1:8791` | Legacy standalone x402 signer: `x402.pay` plus non-mutating probe | `.wrangler/harbor-local-x402` |
| `npm run dev:local:x402:isolated:v1` | `127.0.0.2:8792` | Isolated x402 signer: `x402.pay` plus non-mutating probe | Required credential-bound external root; no default |
| `npm run dev:local:trading` | `127.0.0.1:8791` | Six trading operations listed below | `.wrangler/harbor-local-trading` |
| `npm run dev:local:trading:onboarding` | `127.0.0.1:8791` | Fourteen onboarding operations listed below | shared legacy trading state |
| `npm run dev:local:trading:isolated:v1` | `127.0.0.2:8791` | Six trading operations listed below | `.wrangler/harbor-local-trading-isolated-v1` |
| `npm run dev:local:trading:isolated:v1:onboarding` | `127.0.0.2:8791` | Fourteen onboarding operations listed below | shared isolated-v1 trading state |

The six-operation trading surface is exactly:

```text
tx.swap
tx.approvalPreflight
tx.approvalReconcile
tx.execute
tx.submit
tx.status
```

The fourteen-operation onboarding surface is exactly:

```text
onboarding.readiness
account.link             account.status            account.revoke
ledger.account.info      ledger.account.lines      ledger.account.tx
policy.get               policy.set
tx.trustSet              tx.approvalPreflight      tx.execute
tx.submit                tx.status
```

Onboarding and trading profiles are mutually exclusive. Stop onboarding before
starting trading; restart onboarding only for lifecycle work such as
revocation. The isolated-v1 pair shares only its exact credential file and D1
state; configs, markers, logs, allowlists, and durable build origins remain
distinct. Requests to isolated trading and onboarding require the exact
uncanonicalized `Host: 127.0.0.2:8791`; isolated x402 requires
`Host: 127.0.0.2:8792` and pins its Wrangler inspector to `127.0.0.2:9232`.
See
[`docs/local-trading-isolated-v1-contract.md`](docs/local-trading-isolated-v1-contract.md).

These commands describe reviewed code paths; they do not authorize creating
credentials, funding accounts, opening wallets, or starting services. The
administrator-alias startup hold applies specifically to the isolated-v1
`127.0.0.2` services.

### Legacy standalone local x402 profile

`npm run dev:local:x402` is a legacy, standalone Testnet signing profile on
`127.0.0.1:8791`. It has its own state at
`.wrangler/harbor-local-x402`, exact external credential file at
`/absolute/private/pilot/harbor-secrets/harbor-local-x402.env.local`, named
principal, dedicated payer, and fixed merchant receiver. It is not used by the
isolated Pilot path on `127.0.0.2` and shares neither its credential nor D1
state. The separately isolated x402 profile is described below.

This is a signing profile, not the credential-free read-only profile. Its
external operation allowlist contains only `x402.pay`; cron and general Harbor
mutation operations remain disabled. Its credential-free
`GET /local/x402/probe` makes one non-mutating, non-redirecting request to the
fixed merchant route at `127.0.0.1:8000`, cancels the body, and reports only
reachability, status, and content type. A reachable `402` proves neither
payment nor settlement.

Harbor generates and controls the dedicated payer signing key. Its seed is
stored only as AES-GCM ciphertext in the isolated local D1, alongside its
public identity, status, and funding metadata; the wrapping KEK and bearer
credential live in the exact external secret file.
Harbor can unwrap that payer solely for the guarded x402 signing flow. The
authenticated `owner` is the Pilot policy namespace, not the payer or merchant;
the user's owner key and the merchant receiver private key never enter Harbor.
The reviewed flow fixes the `compare` resource and merchant receiver, caps one
payment at 100,000 drops, rejects a fee above 100 drops, atomically reserves
amount plus fee, caps a UTC day at 1,000,000 drops, signs once, and delivers
merchant data only after independent validated XRPL proof.

Provisioning is a separate, mutating action that requires contemporaneous
approval for credential creation and Testnet funding, with every local Harbor
profile stopped:

```bash
npm run provision:local:x402 -- \
  --provision-testnet-payer \
  --principal '<NAMED_LOCAL_PRINCIPAL>' \
  --owner '<AUTHENTICATED_PILOT_WALLET_ADDRESS>' \
  --merchant-pay-to '<APPROVED_TESTNET_MERCHANT_ADDRESS>'
```

The one-shot provisioner refuses an existing secret file or unsafe state,
persists a faucet intent before its single official Testnet funding request,
and never prints the payer seed, KEK, or bearer token. Do not run provisioning,
the profile, funding, or signing as part of offline development.

### Isolated local x402 v1 profile

The destination provides a separate x402-only Harbor process at
`http://127.0.0.2:8792`, with raw `Host: 127.0.0.2:8792` and Wrangler inspector
`127.0.0.2:9232`. Pilot can address this process with a dedicated named bearer;
it is not enabled inside the trading/onboarding process at `127.0.0.2:8791`.
The merchant remains fixed at `127.0.0.1:8000`. Alternate hosts, forwarded
authority, redirects, caller-selected targets, trading markers, and every
operation other than `x402.pay` fail closed.

The isolated process has its own D1 tree and private files:

- one explicitly approved external absolute state root, bound into both the
  Harbor credential and an immutable root marker; no checkout-relative fallback
- `/absolute/private/pilot/harbor-secrets/harbor-local-x402-isolated-v1.env.local`
- `/absolute/private/pilot/pilot-secrets/pilot-isolated-x402-capability-v1.env.local`

The Harbor file contains the dedicated credential, KEK, and exact profile
markers. The Pilot capability file contains only that dedicated named bearer;
it does not copy the existing Pilot session secret or trading credential. The
same guarded x402 engine and encrypted payer-key custody described above apply,
but its principal, payer, credential, process, and D1 state are isolated from
both legacy x402 and isolated trading.

Provisioning remains deliberately unexecuted. It would create persistent
credentials, a payer, private files, and one bounded official Testnet funding
request, so it requires separate action-time authorization and operator
presence. Before provisioning, the operator must save the unmodified public
`data` results from `account.status` and `onboarding.readiness` at
`/absolute/private/pilot/evidence/pilot-isolated-trading-delegate-v1.json`
using
[`config/pilot-isolated-trading-delegate-evidence-v1.json.template`](config/pilot-isolated-trading-delegate-evidence-v1.json.template).
The evidence must be a private mode-`0600` file with an empty native ACL and
must prove one active Testnet link, exact reviewed permissions, all readiness
checks true, and concordant owner and active delegate.

The reviewed command shape is:

```bash
npm run provision:local:x402:isolated:v1 -- \
  --provision-testnet-payer \
  --state-mode initialize \
  --state-root '<APPROVED_ABSOLUTE_EXTERNAL_ROOT>' \
  --principal '<NEW_X402_ONLY_PRINCIPAL>' \
  --trading-principal '<EXISTING_ISOLATED_TRADING_PRINCIPAL>' \
  --owner '<AUTHENTICATED_PILOT_OWNER_PUBLIC_ADDRESS>' \
  --merchant-pay-to '<APPROVED_TESTNET_MERCHANT_ADDRESS>' \
  --trading-delegate '<ACTIVE_ISOLATED_TRADING_DELEGATE_PUBLIC_ADDRESS>'
```

`initialize` alone may create an absent leaf and apply the isolated migrations.
`resume` requires the same immutable marker and complete real Miniflare D1
layout and applies no migration. The launcher is resume-only and never creates
a replacement state tree. The proposed root for later operator review is
`/absolute/private/pilot/harbor-state/harbor-local-x402-isolated-v1`; it is
not a code default and has not been created or approved for activation.

Every CLI value and the evidence file are validated before migrations, D1
open, secret publication, payer generation, or a faucet request. The new x402
principal must differ from the trading principal, and the generated or resumed
payer must differ from the owner, merchant, and evidence-bound active trading
delegate. The provisioner binds `--trading-principal` to the named principal
read through the fixed-path isolated-trading credential validator before any
state or x402-secret effect. Offline source and fixture checks do not prove that
the state root, evidence file, credentials, payer, listener, payment, or live
Testnet result exists. See the
[isolated x402 v1 contract](docs/local-x402-isolated-v1-contract.md).

### Safe configuration placeholders

Never commit `.dev.vars`, `.env`, bearer tokens, KEKs, wallet seeds, private
keys, mnemonics, or signed transaction blobs. Non-secret defaults belong in
`.env.example`; profile-specific examples live in `config/*.env.template`.

```dotenv
# Illustrative placeholders only — do not paste real values into a tracked file.
HARBOR_API_KEYS=<principal>:<32-to-128-character-base64url-token>
HARBOR_KEK=<canonical-base64-encoded-32-byte-key>
EXEC_NETWORK=testnet
MAINNET_EXECUTION=false
```

`HARBOR_KEK` must decode from canonical padded Base64 to exactly 32 bytes.
Local signing profiles require their exact external secret path and reject
extra keys, unsafe ownership, permissive modes, symlinks, hard links, and
configuration overrides. Use the reviewed provisioners only with separate
action-time approval; they refuse to overwrite an existing credential file.

## MCP client configuration

Use an HTTPS deployment that you have independently verified. The examples
below intentionally contain placeholders and do not assert that any particular
hosted Worker has passed live acceptance.

```bash
export HARBOR_URL='https://<verified-harbor-worker>'
export HARBOR_API_KEY='<principal>:<token>'
```

### Claude Code

```bash
claude mcp add --scope user --transport http harbor "$HARBOR_URL/mcp" \
  --header "Authorization: Bearer $HARBOR_API_KEY"
claude mcp get harbor
```

### Codex

Add this to Codex `config.toml`; `bearer_token_env_var` names the environment
variable rather than embedding its value in the file:

```toml
[mcp_servers.harbor]
url = "https://<verified-harbor-worker>/mcp"
bearer_token_env_var = "HARBOR_API_KEY"
```

See the official [Codex MCP configuration reference](https://developers.openai.com/codex/mcp/).

### Generic Streamable HTTP client

Configure the server URL as `$HARBOR_URL/mcp` and add the authorization header
without logging or storing it in project files. Organization-wide connectors
should use a deliberately scoped principal rather than a personal credential.

## Provisioning and deployment

### Free/QuickJS code-only profile

[`wrangler.free-quickjs.jsonc`](wrangler.free-quickjs.jsonc) is an inert
template for a no-spend deployment review. It has no Worker Loader binding and
no cron, keeps mainnet, autonomous execution, QuickNode, Mastercard MCP, KMS,
AP4M, and shared model access off, and exposes only MCP search. MCP `execute`
stays unregistered until a separately authorized Workers Free CPU acceptance
run shows that the QuickJS path fits the plan's CPU budget.

The checked-in template is deliberately not deployable: its Worker, existing
D1 database, and HTTPS custom-domain origin are placeholders. Generate an
operator-specific local config only after those three targets are approved:

```bash
npm run config:free:generate -- \
  --profile free-quickjs \
  --worker-name <approved-worker-name> \
  --database-name <approved-existing-d1-name> \
  --database-id <approved-existing-d1-uuid> \
  --origin https://<approved-harbor-origin> \
  --output ./wrangler.free-quickjs.operator.jsonc
```

The generator only writes a new local file and refuses to overwrite the shared
or template configs. It does not authenticate, probe remote features, create a
Worker or D1 database, upload secrets, apply migrations, fund wallets, or
deploy. The checked-in bundle can be verified locally without contacting
Cloudflare:

```bash
npm run deploy:free:dry-run
npm run cf-typegen:free:check
```

### Paid Dynamic Worker bootstrap

The repository includes [`scripts/bootstrap.sh`](scripts/bootstrap.sh) for the
single scoped paid Dynamic Worker and D1 environment defined by the external
run kit. It is not a general installer: it mutates Cloudflare configuration,
writes secrets outside Git, checks amendments, and creates test-ledger
fixtures. It now rejects non-paid profiles and will not silently fall back to
QuickJS when the remote Worker Loader probe fails. Read and approve its exact
scope before use.

```bash
./scripts/bootstrap.sh
```

`scripts/teardown.sh` is separate and destructive. Neither bootstrap,
deployment, local credential provisioning, funding, nor teardown is part of
the offline development flow.

## Testing

| Command | Scope |
| --- | --- |
| `npm run aws-local` | Run the loopback-only AWS stand-in on `127.0.0.1:8790` |
| `npm run dev` | Regenerate the catalog and run Wrangler locally |
| `npm run typecheck` | Regenerate catalog artifacts and run `tsc --noEmit` |
| `npm test` | Regenerate catalog artifacts and run all offline Vitest suites |
| `npm run test:smoke` | Run opt-in smoke tests against `HARBOR_SMOKE_URL` |
| `npm run deploy` | Regenerate the catalog and deploy the scoped Worker |
| `npm run deploy:free:dry-run` | Bundle the inert no-loader Free/QuickJS template locally; never deploy |
| `npm run config:free:generate -- ...` | Write a new explicitly targeted Free/QuickJS config without cloud actions |
| `node scripts/build-catalog.mjs` | Validate venue YAML and regenerate ignored catalog/operation artifacts |
| `npm run cf-typegen` | Refresh Worker binding types from Wrangler configuration |
| `npm run cf-typegen:free` | Refresh the no-loader Free/QuickJS binding types |

The offline suite covers schemas, guards, adapters, builders, policy,
reservation races, replay protection, migrations, execution reconciliation,
watcher suspension, fixed launchers, isolated profile boundaries, and complete
fake-ledger onboarding-to-trading lifecycle contracts. It also covers the
isolated x402 launcher, server gates, mocked provisioner and trading-delegate
evidence validation, plus no-socket dispatch through the exact reviewed Pilot
request builder. Skipped, mocked, fixture, or no-socket tests are not live
acceptance.

## Security properties and limitations

- **No owner-key custody:** Harbor accepts owner-signed blobs only through
  tightly bound approval or onboarding routes; it never accepts an owner seed.
  Harbor does custody wrapped operational delegate and x402 payer keys and can
  unwrap them only within their guarded signing paths.
- **No Mainnet execution:** builders may read public Mainnet data where an
  operation supports it, but signing and submission reject Mainnet.
- **Fail-closed profile gates:** malformed or mixed local markers, wrong
  networks, alternate hosts, forwarded authority, unknown operations, and
  cross-profile durable origins are denied.
- **Atomic authorization:** idempotency, daily budget, immutable v2 snapshot,
  and one-shot relay claims are durable before signing or network submission.
- **Ambiguous outcomes remain reserved:** unknown submission status is
  reconciled; it is not retried as a new transaction.
- **Bounded JSON-RPC, not bounded generic WebSocket:** XRPL JSON-RPC responses
  are capped at 4 MiB. The generic WebSocket transport does not yet have the
  equivalent cap. Reviewed local signing profiles exclude endpoint overrides
  and WebSocket-only operations so their reachable calls use JSON-RPC HTTP.
- **Network features vary:** vault and lending builders depend on amendments
  and network availability. Registered operations and passing offline tests do
  not prove a live network supports them.
- **x402 is narrow, local, and separate:** both the legacy `127.0.0.1:8791`
  and isolated `127.0.0.2:8792` signing profiles permit only `x402.pay`, fix the
  merchant resource, reserve amount plus fee budget, and require independent
  validated XRPL settlement. The isolated x402 process has authority and state
  separate from isolated trading at `127.0.0.2:8791`.
- **Current operational hold:** isolated-v1 `127.0.0.2` service startup awaits
  the administrator-alias handoff, and the older delegation remains unresolved.
  Do not claim completed activation, live execution, or revocation from this
  README.

Report security issues privately to the repository owner. Never include a
credential, seed, private key, mnemonic, signed blob, or encrypted key material
in an issue, log, screenshot, or prompt.

## Documentation

- [Execution lifetime v2 contract](docs/execution-lifetime-v2-contract.md)
- [Isolated local trading v1 contract](docs/local-trading-isolated-v1-contract.md)
- [Isolated local x402 v1 contract](docs/local-x402-isolated-v1-contract.md)
- [Legacy local trading profile](docs/local-trading.md)
- [Legacy local onboarding profile](docs/local-trading-onboarding.md)
- [Diagram prompt pack](docs/diagram-prompts.md)
- [Proposed GitHub repository metadata](docs/repository-about.md)
- [Golden evaluation guide](eval/README.md)
- Operational decisions and generated status evidence belong in owner-controlled records outside the destination repository.

## Credits

Harbor is implemented from scratch and depends on:

- [`xrpl`](https://github.com/XRPLF/xrpl.js) — XRP Ledger client and wallet utilities
- [`zod`](https://zod.dev/) — runtime schemas and inferred contract types
- [`minisearch`](https://lucaong.github.io/minisearch/) — operation catalog search
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP server and Streamable HTTP transport
- [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten) — fallback script sandbox
- [`yaml`](https://eemeli.org/yaml/) — venue catalog parsing
- [`aws4fetch`](https://github.com/mhart/aws4fetch) — narrow SigV4 signing for the AWS trust-layer clients
- [`@noble/curves`](https://github.com/paulmillr/noble-curves) — Ed25519 implementation for the local KMS stand-in
- [`ripple-keypairs`](https://github.com/XRPLF/xrpl.js/tree/main/packages/ripple-keypairs) — independent XRPL-compatible verification in stand-in tests
- [`viem`](https://viem.sh/) — exact ABI, event-log, address, and EIP-712 validation for the isolated XRPL EVM Testnet AP4M event adapter
- [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) — Worker and D1 development/deployment
- [`@cloudflare/vitest-plugin`](https://developers.cloudflare.com/workers/testing/vitest-integration/) — Cloudflare Worker test integration available for later live suites
- [`vitest`](https://vitest.dev/) — offline unit tests
- [`typescript`](https://www.typescriptlang.org/) and [`@types/node`](https://github.com/DefinitelyTyped/DefinitelyTyped) — type checking

Public documentation and data sources used to implement or describe Harbor:

- [AWS `InvokeGuardrailChecks` API](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InvokeGuardrailChecks.html) — request and response shape mirrored by the deterministic local stand-in
- [XRPL documentation](https://xrpl.org/docs/) — ledger APIs, amounts and currency formats, reserves, transaction fields, simulation, reliable submission, AMMs, vaults, lending, RLUSD, and Permission Delegation; [xrpl.js](https://js.xrpl.org/), [xrpl-py](https://xrpl-py.readthedocs.io/), [XRPL Standards](https://github.com/XRPLF/XRPL-Standards), and [rippled documentation](https://opensource.ripple.com/) are additional documentation-corpus sources
- [XRPL Docs MCP](https://xrpl.org/resources/dev-tools/ai-tools) — proxied documentation search across the XRPL documentation corpus
- [XRPLF agent wallet, payments, and trading skills](https://github.com/XRPLF/xrpl-dev-portal/tree/master/.claude/skills/xrpl-skills) — pinned external reference playbooks; Harbor's local playbooks retain stricter key-custody, policy, approval, and test-network rules
- [Cloudflare Workers](https://developers.cloudflare.com/workers/), [Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/), [Code Mode](https://blog.cloudflare.com/code-mode-mcp/), and [Web Crypto AES-GCM](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/encrypt#aes-gcm) — Worker hosting, the two-tool sandbox pattern, Loader bindings/no-egress execution, D1 tooling, and delegate-key wrapping
- [XRPL.to API](https://xrpl.to/docs/), [XRPSCAN API](https://docs.xrpscan.com/api-documentation/), and [Bithomp API](https://docs.bithomp.com/) — bounded external token and AMM metadata sources with explicit fallbacks
- [Hyperliquid Info API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals) — read-only XRP perpetual market metadata
- Venue and product references used by the catalog: [Doppler Finance](https://docs.doppler.finance/product/doppler-vaults.md), [First Ledger](https://docs.firstledger.net/), [Horizon](https://horizonxrpl.com/documentation), [Magnetic X](https://xmagnetic.org/WhitePaper.pdf), [MarsGate](https://www.marsgate.xyz/), [Moai Finance](https://medium.com/@moai-finance/moai-finance-unleashing-the-untapped-potential-of-xrp-8b4938378c31), [Orchestra Finance](https://orchestra.finance/), [Securd](https://docs.securd.org/documentation), [SOIL](https://soil.co/#products), [Strobe Finance](https://strobe-protocol.gitbook.io/strobe-protocol/money-market), [Sologenic](https://sologenic.org/xls-30), [XPMarket](https://xpmarket.com/amm/guide), [XRPL EVM](https://docs.xrplevm.org/pages/developers), and [XRPL x402](https://xrpl-x402.t54.ai/docs/xrpl-scheme)
- MCP client setup references: [Claude Code](https://code.claude.com/docs/en/mcp), [Claude custom connectors](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp), [Codex](https://developers.openai.com/codex/mcp), and [Cursor](https://cursor.com/docs/mcp)

These references informed protocol behavior, adapters, catalog facts, and setup
instructions. Harbor does not copy or import third-party project source code;
third-party executable code enters only through the packages listed above.
