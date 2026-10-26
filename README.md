# pilot
Pilot is an XRP Ledger agent interface that keeps owner keys in the user’s
wallet. A user can research opportunities in chat, inspect a typed transaction
intent, apply policy, and either delegate an allowed action to Harbor or approve
an exact transaction in their own wallet. Pilot never receives the owner key:
an external wallet keeps it, while the isolated test signer remains
browser-local. Harbor separately stores encrypted limited-purpose delegate keys
and standalone payer keys, and unwraps them only for authorized signing. Pilot
writes validated activity and preferences to an Obsidian-compatible Markdown
vault.

> **Suggested GitHub About:** XRPL agent UI for typed intents, owner-wallet
> approvals, policy-gated Harbor execution, and Markdown memory.

The interface currently includes Chat, Map, Portfolio, Memory, and Onboarding.
The repository is designed around explicit evidence boundaries: a fixture card
is presentation evidence, a build is not a submission, and a requested
revocation is not a validated revocation.

## Current status

| Area | Status | What that means |
| --- | --- | --- |
| Offline application and UI | Available for development | Run the documented typecheck, offline tests, build, and fixture browser lanes in this destination. |
| Public onboarding | Not accepted | A supported hosted wallet flow requires separate manual acceptance. |
| Live trading, x402, and revocation | Not accepted | Fixtures and code checks are not live ledger evidence. |
| Production | Not ready | No production deployment, mainnet execution, or production acceptance is claimed. |

The accepted isolated profile is a fixed safety contract, not a portable public
launcher. It binds Pilot to `http://127.0.0.2:3003`, ordinary Harbor operations
to `http://127.0.0.2:8791`, and only `x402.pay` to the dedicated Harbor process
at `http://127.0.0.2:8792`. Trading/onboarding and x402 use distinct principals,
bearers, state, and process profiles. Alternate hosts, ports, forwarded
authority, generic dotenv files, mixed profiles, and credential reuse fail
closed. Do not start it until the runtime owner confirms the administrator
loopback handoff and the exact setup runbook.

The `.2:8792` capability does not route through or adopt the legacy standalone
`.1` x402 service. Legacy credentials, state, payer, and merchant evidence stay
separate preservation targets.

## Safe local development on macOS

### Prerequisites

- macOS with Node.js 24 or newer;
- pnpm `10.32.1` (the version pinned in `package.json`);
- Git; and
- Chromium installed by Playwright for browser tests.

No Harbor credential, wallet, seed, session secret, OpenRouter key, faucet,
XRPL connection, or external environment file is needed for the default
fixture workflow.
The development server binds only to `http://127.0.0.1:3003`. Use that exact origin; `localhost`, IPv6 loopback, HTTPS, and other ports are outside the reviewed local-wallet boundary. The checked-in [.env.example](.env.example) documents every Pilot environment variable without containing credentials.

Local-wallet chat requires a fresh browser-wallet proof before model or tool access in both `HARBOR_MOCK=1` and `HARBOR_MOCK=0`. Configure a server-only `SESSION_SECRET` with at least 32 characters after trimming and set `P_LIVE_RLUSD_ACQUISITION_STATE_DIR` to a nonblank absolute path for a preexisting, current-user-owned, non-symlink replay-marker directory with exact mode `0700`. Until both prerequisites validate and the wallet session is authenticated, the chat UI remains disabled. Public configuration performs the same read-only directory validation used again at proof consumption and exposes only a strict readiness boolean, never the secret or directory path.

Hosted deployments must set `PILOT_DEPLOYMENT_PROFILE=hosted`, keep `NEXT_PUBLIC_DEV_SIGNER=0`, and set `PILOT_PUBLIC_ORIGIN` to the exact normalized browser origin (for example, `https://pilot.example`). The value must be HTTPS and non-loopback, with no credentials, path, query, fragment, trailing slash, or default-port spelling. Pilot uses this explicit origin across reverse proxies and never derives browser authority from an internal request URL or forwarding headers.

### Install and verify

Use a separate worktree when another engineer or runtime owner is working from
the same clone. Never develop in a watched runtime checkout.
The market-maker and its 30-second offer-ladder refresh provide synthetic liquidity for Testnet and Devnet demos. They are not real trading volume, and these tools never submit Mainnet transactions.

Choose a supported test network, seed it, and then keep the ladder refreshed:

```bash
export EXEC_NETWORK=testnet # or devnet
pnpm tsx scripts/seed.ts --network "$EXEC_NETWORK"
pnpm tsx scripts/mm-loop.ts --network "$EXEC_NETWORK"
```

Seeding prefers test-network RLUSD when the market-maker is already funded with it. If RLUSD is unavailable, the seed script creates the demo stablecoin `tUSD` and configures it as the $1 fallback. Network-specific `STABLE_CODE_TESTNET` and `STABLE_CODE_DEVNET` values keep the funding route correct if the two test networks use different stablecoins; `STABLE_CODE` remains the active execution-network default for Harbor. The seed command is safe to rerun: it tops up the demo state instead of intentionally duplicating it.

If `MM_WALLET_SEED` is absent, the seed command stops before creating a credential. After the owner has explicitly approved persisting a new test-only market-maker credential, rerun once with `ALLOW_TEST_CREDENTIAL_PERSISTENCE=1`; the seed is added only to the external secrets file and is never written to Git or printed.

`POST /api/dev/fund` is also test-network-only. The destination budget account must first establish a trust line to the selected RLUSD or `tUSD` issuer; an eligible request receives 1,000 units of that demo stablecoin. Funding is limited to one request per destination address every 10 minutes. This demo handoff is not the localhost Testnet dev-signer acceptance path: that path remains pinned to official Testnet RLUSD and obtains exactly 75 RLUSD through an owner-approved fixed-buy FOK transaction. A market maker holding only tUSD cannot satisfy that requirement, and Pilot never relabels tUSD or invents an issuer faucet.

Keep `MM_WALLET_SEED` and every other credential only in the externally managed environment file linked during setup. Never paste, print, log, or commit seeds, `.env` files, private keys, or mnemonics. `scripts/seed.json` contains public demo metadata only and must never contain seed material.

## Checks

```bash
pnpm install --frozen-lockfile
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm typecheck
pnpm test
pnpm test:e2e:fixture
pnpm --filter web build
```

`pnpm test:e2e:fixture` starts its own server on `127.0.0.1:3004`, scrubs the
parent environment down to a small process allowlist, disables signing and
telemetry, blanks live endpoints and credentials, and intercepts the UI's HTTP
prerequisites with deterministic fixtures. It must not share port `3004` with
another process.

For an interactive Playwright workbench, use the same fixture project:

```bash
PILOT_E2E_LANE=fixture pnpm exec playwright test --project=fixture --ui
```

Run individual fixture specifications while iterating:

```bash
PILOT_E2E_LANE=fixture pnpm exec playwright test \
  e2e/03-delegated-actions.fixture.spec.ts --project=fixture
```

Do not use `pnpm dev` on an arbitrary port as a substitute for this workflow.
The wallet profiles intentionally require exact authorities, while the fixture
project is the reviewed credential-free lane for simultaneous UI work.

### Optional Python x402 checks

Dependency installation below uses PyPI network access. After installation, the
test command runs the protocol suite offline; neither step is proof of a working
payment round trip. Keep the virtual environment outside the repository:

```bash
PILOT_X402_VENV="$(mktemp -d "${TMPDIR:-/tmp}/pilot-x402-venv.XXXXXX")"
python3.11 -m venv "$PILOT_X402_VENV"
"$PILOT_X402_VENV/bin/python" -m pip install \
  --index-url https://pypi.org/simple \
  --require-hashes \
  --requirement apps/web/api/x402/requirements-test.lock
HTTP_PROXY=http://127.0.0.1:9 \
HTTPS_PROXY=http://127.0.0.1:9 \
NO_PROXY=127.0.0.1,localhost \
PYTHONDONTWRITEBYTECODE=1 \
"$PILOT_X402_VENV/bin/python" -m pytest -q apps/web/api/x402/tests
```

## Fixture coverage

The browser suite exercises eight deterministic product stories:

1. onboarding preconditions without a signer;
2. research with freshness and risk caveats;
3. delegated swap and exact `AMMDeposit` card shapes;
4. a policy-blocked action;
5. owner approval and transaction presentation;
6. x402 presentation and accounting boundaries;
7. revocation presentation; and
8. vault-backed Memory and preference states.

These flows validate rendering, state transitions, and contracts only. They do
not connect a wallet, fund an account, sign, relay, mutate Harbor, or prove an
XRPL result.

### Reviewable personalization (default off)

With all three structured-preference settings below configured, Pilot can
turn an explicitly durable statement such as “I prefer concise summaries in
future chats” into a wallet- and network-scoped proposal. The user must accept
the proposal before Pilot supplies it to later chats. The Memory page exposes
pending and accepted records with reject, correct, and forget controls.

An explicit research preference such as “I prefer conservative trade analysis”
can become a capital-preservation-first research-ordering proposal even for a
new user. It changes which caveats and downside evidence appear first, never an
intent, amount, route, limit, approval, or execution decision. Repeated facts
in the application's scoped validated-transaction journal can also produce a
pending candidate to include familiar asset or transaction-type context. A
single event is insufficient, the candidate is never silently accepted, and
the journal record is not described as a fresh ledger attestation. Pilot does
not infer risk tolerance, profitability, fill quality, or venue preference
from those records.

Current-request instructions override remembered style, and temporary wording
is not persisted. Preference values are quoted as bounded, untrusted context;
they cannot change transaction permissions, amounts, risk limits, policy,
approval requirements, or signing. Validated trades continue to be journaled
separately with unavailable execution metrics labeled as unavailable rather
than converted into performance claims.

Hosted mode encrypts each preference or workflow-lesson document before it
leaves Pilot, bounds every encrypted document to a 1 MiB plaintext envelope,
and limits each dedicated Harbor principal to 4,096 personalization rows.
Record-level “forget” retains the application's content-free tombstone for
idempotency; the separate exact-digest internal deletion primitive physically
removes an entire scoped document for account cleanup without exposing that
operation to the browser, model tools, Harbor REST operations, or MCP.

## Environment reference

[`.env.example`](.env.example) contains names, public defaults, and empty secret
placeholders. It is a reference for manual legacy-local or hosted development;
the fixture E2E runner supplies its own scrubbed environment, and the isolated
launcher rejects generic `.env*` files.

| Name | Visibility | Purpose and constraint |
| --- | --- | --- |
| `PILOT_DEPLOYMENT_PROFILE` | Server | Required profile: `local-wallet`, `local-wallet-isolated-v1`, or `hosted`. Never mix profile artifacts. |
| `NEXT_PUBLIC_PILOT_BUILD_MARKER` | Public | Required only for the isolated build and fixed to `pilot-local-wallet-isolated-v1`; legacy and hosted profiles reject it. |
| `PILOT_PUBLIC_ORIGIN` | Server | Hosted-only exact HTTPS browser origin. Loopback, paths, credentials, query strings, fragments, and inferred forwarding headers are rejected. |
| `HARBOR_MOCK` | Public behavior | Literal `1` for fixtures or `0` for a reviewed Harbor. Any other value fails closed. |
| `HARBOR_URL` | Server | Exact profile-bound upstream. The isolated launcher pins `http://127.0.0.2:8791`; caller-selected alternatives are rejected. |
| `HARBOR_API_KEY` | Secret, server-only | Bearer used only by Pilot's server-side Harbor client. Never expose it through `NEXT_PUBLIC_*`. |
| `PILOT_HOSTED_STATE_API_KEY` | Secret, server-only | Dedicated named bearer for the private hosted-state operations. Its principal and token must both differ from `HARBOR_API_KEY`; Harbor rejects shared credentials and denies its principal ordinary ops and MCP. |
| `HARBOR_X402_URL` | Server | Present only in the argument-free isolated x402 launcher and fixed to `http://127.0.0.2:8792`. It is used only for `x402.pay`; browser input and ordinary Harbor operations cannot select it. |
| `HARBOR_X402_API_KEY` | Secret, server-only | Dedicated named x402 bearer loaded from the fixed capability file. Its principal and token must both differ from `HARBOR_API_KEY`; it is never browser-visible. |
| `EXEC_NETWORK` | Public behavior | `testnet` or `devnet` for supported local development. Mainnet execution is prohibited. |
| `NEXT_PUBLIC_DEV_SIGNER` | Public | Test-network browser signer gate. Hosted mode rejects `1`; fixture E2E enforces `0`. |
| `SESSION_SECRET` | Secret, server-only | At least 32 trimmed characters. Used for encrypted sessions and wallet-action proofs; never log or rotate during recovery. |
| `P_LIVE_RLUSD_ACQUISITION_STATE_DIR` | Private path | Existing, current-user-owned, non-symlink directory with mode `0700`. Pilot does not create it. |
| `P_LIVE_HARBOR_FOK_DEPLOYED` | Server gate | Literal `1` only after the reviewed fixed-buy FOK contract is present. |
| `P_LIVE_HARBOR_OWNER_APPROVAL_DEPLOYED` | Server gate | Literal `1` only after the reviewed owner-approval contract is present. |
| `P_LIVE_HARBOR_EXECUTION_V2` | Server gate | Literal `1` opts the dedicated official-RLUSD acquisition route into `xrpl_execution_v2`; it is not a session-wide capability. |
| `DEMO_OPENROUTER_API_KEY` | Secret, server-only | Dedicated free-demo credential. It is inert unless the complete zero-paid policy and finite quota configuration validates; never place it in browser code or fixture evidence. |
| `DEMO_MODEL_ENABLED`, `DEMO_MODEL_COST_POLICY` | Server gate | Default off. Enabling requires literal `1` and cost policy `free-only`, plus every finite quota and operator acceptance below. |
| `DEMO_MODEL_QUOTA_BACKEND` | Deployment gate | Must be exactly `sqlite-single-host`. This backend is rejected on Vercel/AWS Lambda and is safe only on one server with one persistent local volume shared by all app processes. |
| `DEMO_MODEL_STATE_DIR` | Private path | Pre-existing absolute non-symlink directory, current-user-owned where supported, with exact mode `0700`. The atomic SQLite quota ledger lives here and must not be inside the repository. |
| `DEMO_MODEL_ALLOWED_MODELS` | Server | Comma-separated exact `:free` model IDs. Every request revalidates current zero pricing and tool support against OpenRouter's catalog. Base IDs, chained variants, `openrouter/free`, fallback arrays, browser-selected providers, and arbitrary base URLs are not accepted. |
| `DEMO_MODEL_GLOBAL_DAILY_REQUESTS`, `DEMO_MODEL_GLOBAL_DAILY_OUTPUT_TOKENS`, `DEMO_MODEL_WALLET_DAILY_OUTPUT_TOKENS` | Server quotas | Positive finite global request and daily output-token reservations, separate from money. Each attempt retains its full request-wide reservation even when usage is missing or uncertain. Legacy micro-USD variables must remain unset or exactly `0`. |
| `DEMO_MODEL_WALLET_DAILY_REQUESTS`, `DEMO_MODEL_RATE_WINDOW_SECONDS`, `DEMO_MODEL_RATE_REQUESTS` | Server limits | Positive finite per-wallet/session daily and short-window request ceilings. |
| `DEMO_MODEL_MAX_GLOBAL_CONCURRENCY`, `DEMO_MODEL_MAX_WALLET_CONCURRENCY`, `DEMO_MODEL_RESERVATION_TTL_SECONDS`, `DEMO_MODEL_ABORT_GRACE_SECONDS` | Server limits | Positive finite active-request bounds. Provider work is aborted before the reservation lease expires; the remaining grace keeps concurrency occupied while cancellation propagates. Expired/crashed reservations become uncertain attempts and keep their daily quota. |
| `DEMO_MODEL_MAX_INPUT_BYTES`, `DEMO_MODEL_MAX_OUTPUT_TOKENS`, `DEMO_MODEL_MAX_STEPS` | Server limits | Positive finite per-request input, output, and agent-step caps. |
| `DEMO_OPENROUTER_KEY_LIMIT_USD`, `DEMO_OPENROUTER_INCLUDE_BYOK_IN_LIMIT`, `DEMO_OPENROUTER_NO_BYOK`, `DEMO_OPENROUTER_PAID_ADDONS_DISABLED`, `DEMO_OPENROUTER_FREE_ONLY_ACCEPTANCE` | Operator acceptance | Required exact assertions are `0`, `1`, `verified`, `verified`, and `verified`. Set them only after a dedicated server key/workspace is confirmed to have no usable BYOK credentials or locked/default paid plugins, and a tiny real request proves the zero key limit still permits the exact free model with zero usage cost. Until then the demo stays disabled. |
| `MODEL_DEFAULT`, `OPENROUTER_ALLOWED_MODELS` | Server | Default model and exact account-model allowlist. Browser input cannot select a provider, base URL, or unlisted model. |
| `NEAR_INTENTS_API_KEY` | Secret, Harbor-only | Optional 1Click partner credential. The implemented surface includes token reads, provider-signature-verified dry quotes, read-only status, the existing local Arbitrum-USDC → wNEAR review, and the hosted-default-off native-NEAR → canonical-Arbitrum-USDC live review. A key alone enables nothing. No operation builds, signs, broadcasts, or funds a transfer. |
| `PILOT_NEAR_INTENTS_EXECUTABLE_REVIEW_ENABLED` | Pilot UI gate | Default `false`. Exposes exact-route review UI only; Harbor's independent gates and principal binding remain authoritative. This flag does not enable funding or execution. |
| `PILOT_NEAR_BROWSER_WALLET_ADAPTER_ENABLED` | Pilot browser-wallet gate | Default `false`. When paired with the independent executable-review gate, constructs Near Connect 0.12.0 only after an explicit user click using one app-supplied, commit-pinned MyNearWallet sandbox executor. It does not auto-connect, create an access key, expose transaction/delegate signing, or broadcast. |
| `PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED` | Pilot NEAR principal gate | Default `false`. When enabled with verify-mode NEP-413 and durable replay state, an active Pilot wallet session may request a five-minute account claim; only a successful full-access-key proof upgrades it to a 15-minute, exact-operation NEAR authorization. The browser cannot choose the opaque principal, and changing or renewing the Pilot wallet session invalidates it. |
| `PILOT_NEAR_OWNER_FUNDED_APPROVAL_ENABLED`, `PILOT_NEAR_OWNER_FUNDED_POLICY_DIGEST` | Pilot economic-approval gate | Default off. Requires a reviewed uppercase SHA-256 policy digest. The browser cannot provide or weaken this value. A fresh quote-bound wallet-control proof and separate explicit owner confirmation are still required before Harbor may reserve; these variables do not enable funding. |
| `HARBOR_LOCAL_NEAR_INTENTS_EXECUTABLE_REVIEW_ENABLED`, `HARBOR_LOCAL_NEAR_INTENTS_PROVIDER_POST_ENABLED`, `HARBOR_LOCAL_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE` | Harbor local gate | All must opt into profile `arb-usdc-to-wnear-manual-v1`, with `HARBOR_LOCAL_DEV=true`, `MAINNET_EXECUTION=false`, and an explicitly configured principal. The operation returns verified owner instructions only. |
| `HARBOR_NEAR_INTENTS_OWNER_FUNDED_REVIEW_ENABLED`, `HARBOR_NEAR_INTENTS_PROVIDER_POST_ENABLED`, `HARBOR_NEAR_INTENTS_STATUS_ENABLED`, `HARBOR_NEAR_INTENTS_EXECUTABLE_REVIEW_PROFILE` | Harbor hosted review gate | All must opt into exact profile `near-native-to-arbitrum-usdc-v1`, with `MAINNET_EXECUTION=false` and an explicitly configured principal. Live mode additionally requires `NEAR_INTENTS_API_KEY`; injected fixtures remain labeled unverified and cannot reserve. Review returns manual native-NEAR funding instructions only. |
| `HARBOR_NEAR_INTENTS_OWNER_FUNDED_RESERVE_ENABLED`, `HARBOR_NEAR_INTENTS_APPROVAL_GATEWAY_PRINCIPAL`, `HARBOR_NEAR_INTENTS_TENANT_ID`, `HARBOR_NEAR_INTENTS_NATIVE_NEAR_BUDGET_LIMIT_ATOMIC` | Harbor hosted reserve gate | Default off. Requires `HARBOR_NEAR_INTENTS_OWNER_FUNDED_REVIEW_ENABLED=true`, profile `near-native-to-arbitrum-usdc-v1`, `MAINNET_EXECUTION=false`, a dedicated configured gateway principal, safe tenant ID, positive server-owned yoctoNEAR limit, D1, an exact verified live quote, and a fresh bound economic approval. The result is a durable reservation/replay record with execution disabled; it cannot sign, broadcast, or fund. |
| `HARBOR_NEAR_INTENTS_OWNER_FUNDED_RECONCILE_ENABLED`, `HARBOR_NEAR_INTENTS_NEAR_RPC_URL`, `HARBOR_NEAR_INTENTS_ARBITRUM_RPC_URL` | Harbor hosted reconciliation gate | Default off. The RPC values must exactly match Pilot's pinned NEAR mainnet and Arbitrum public origins. The operation independently verifies the exact finalized native-NEAR source transfer and canonical-USDC destination event, persists provider `SUCCESS` separately, and always reports `safe_to_resubmit=false`. Provider `REFUNDED` remains held because refund discovery and receipt verification are not implemented. |
| `PILOT_NEAR_WALLET_PROOF_MODE`, `PILOT_NEAR_WALLET_PROOF_PROVIDER`, `PILOT_NEAR_WALLET_PROOF_RECIPIENT` | Pilot wallet-proof gate | Default `disabled`. `verify` mode is only the NEP-413 source-account-control boundary and requires fixed provider/recipient configuration plus hosted replay state. It is not economic transfer approval, and no real browser-wallet prompt was accepted in this work. |
| `NEAR_AI_ENABLED`, `NEAR_AI_MODEL`, `NEAR_AI_PRIVACY_TIER` | Server gate | Default off. Enables the optional NEAR AI OpenAI-compatible configuration only after an operator selects an exact current ready model and explicitly declares its privacy tier. The adapter reports that runtime attestation is not verified. |
| `NEAR_AI_API_KEY` | Secret, server-only | Optional NEAR AI credential. It is stripped from public provider descriptors and is never accepted from browser input. |
| `NEAR_RPC_READ_ENABLED`, `NEAR_RPC_NETWORK`, `NEAR_RPC_URL` | Server read gate | Default off. Enables only bounded `status` and final `view_account` calls to Pilot's fixed official mainnet or testnet RPC origin. It exposes no transaction broadcast method. |
| `VAULT_BACKEND`, `VAULT_PATH` | Server | Select filesystem vault storage and its root. Wallet-scoped data remains isolated. |
| `VAULT_GITHUB_TOKEN`, `VAULT_REPO` | Secret/server | Optional GitHub-backed vault configuration; not needed for fixture development. |
| `PILOT_STRUCTURED_PREFERENCES` | Server gate | Default `0`. Literal `1` enables reviewable structured preferences and validated-experience workflow lessons without changing legacy profile strings or transaction policy. |
| `PILOT_PERSONALIZATION_BACKEND` | Server | `local` uses the owner-private filesystem path below. `harbor-d1` is hosted-only, requires the dedicated state bearer and `SESSION_SECRET`, encrypts values before Harbor, and never falls back to local storage. |
| `PILOT_PERSONALIZATION_TENANT_ID` | Server | Required with the structured-preference gate. The browser cannot choose tenant, wallet, or network scope. |
| `PILOT_PERSONALIZATION_STATE_DIR` | Private path | Required with the structured-personalization gate. Must be a current-user-owned local directory with mode `0700` (or stricter) outside `VAULT_PATH`; preferences, workflow lessons, and their evidence references are never written to the GitHub vault backend. |
| `PILOT_PERSONALIZATION_FIXTURE` | Development-only gate | Default `0`. Literal `1` enables the fixed synthetic personalization browser scope only with mock Harbor, structured preferences, a configured private state directory, and a development/test runtime. Production, hosted, isolated, or live-Harbor modes reject it. The fixture cookie is not wallet authorization. |
| `BACKTEST_EXTERNAL_READS_ENABLED`, `BACKTEST_QUOTA_BACKEND` | Server gate | Default off. Local single-host work may use `sqlite-single-host`; hosted/serverless work must use `harbor-d1`. Incomplete or unavailable shared quota configuration blocks the provider read. |
| `BACKTEST_QUOTA_POLICY_VERSION`, `BACKTEST_QUOTA_ACCOUNT_HOURLY_RUNS`, `BACKTEST_QUOTA_SESSION_HOURLY_RUNS` | Server limits | Exact shared policy and finite hourly account/session reservations. Pilot sends only `SESSION_SECRET`-HMAC scopes; malformed requests are rejected before quota is consumed. |
| `STABLE_CODE_TESTNET`, `STABLE_ISSUER_TESTNET` | Public data | Optional Testnet asset display metadata. The isolated acquisition remains fixed to official Testnet RLUSD. |

OpenRouter OAuth uses PKCE S256 plus a single-use state cookie. Because the
wallet session deliberately remains `SameSite=Strict`, the cross-site provider
callback can create only a short-lived encrypted pending credential. A fresh
same-origin browser request then binds it to the exact wallet cookie and
promotes it to a session lasting no longer than 60 minutes. “Disconnect
OpenRouter locally” only clears Pilot's cookies; provider-side revocation must
be completed in OpenRouter settings.

Never commit `.env*` other than the tracked, placeholder-only `.env.example`;
never commit vault output, seeds, mnemonics, signed blobs, session secrets,
Harbor keys, OpenRouter keys, or wallet exports. Do not `source` a historical
environment wholesale; an operator should load only the explicit allowlist for
the selected profile.

## Runtime profiles

### Fixture profile — the default engineering lane

- Command: `pnpm test:e2e:fixture`
- Origin: `http://127.0.0.1:3004`
- Credentials: none
- Ledger access: none
- Signing/funding: disabled
- Evidence label: fixture/offline only

### Isolated local Testnet profile — accepted code, paused startup

- Pilot profile: `local-wallet-isolated-v1`
- Pilot origin: exactly `http://127.0.0.2:3003`
- Harbor origin and raw Host: exactly `http://127.0.0.2:8791` and
  `127.0.0.2:8791`
- Dedicated x402 Harbor origin and raw Host: exactly
  `http://127.0.0.2:8792` and `127.0.0.2:8792`
- Pilot launcher: `pnpm dev:isolated` (accepts no arguments)
- Profiles: Harbor onboarding and trading run sequentially, never concurrently
- State: dedicated and profile-tagged; legacy/isolated cross-use fails closed
- Current blocker: administrator loopback alias handoff on the Mac

The source-reviewed x402 extension retains the same Pilot origin while routing
only `x402.pay` to Harbor origin and raw Host `http://127.0.0.2:8792` /
`127.0.0.2:8792`. It uses:

- Pilot launcher `pnpm dev:isolated:x402` with no arguments;
- a second fixed, server-only capability file containing only the x402 named
  bearer;
- Harbor's x402-only `x402.pay` allowlist, dedicated credential, payer, KEK,
  D1 state, and process profile; and
- the reviewed fixed merchant at `127.0.0.1:8000`.

Ordinary Harbor calls remain on `.2:8791`. The `.2:8792` profile cannot adopt
legacy `.1` x402 credentials, payer, state, or runtime markers. Source review is
not provisioning or live acceptance: no isolated x402 capability, payer,
funding, listener, or paid request is claimed here. See
[`docs/isolated-x402-profile.md`](docs/isolated-x402-profile.md).

The repository does not add or remove the macOS alias. An operator may inspect
the handoff without changing networking:

```bash
ifconfig lo0 | grep 'inet 127.0.0.2'
```

Until the administrator confirms that handoff, do not run `pnpm dev:isolated`
or `pnpm dev:isolated:x402`, bind any `.2` port, create credentials or state,
open a wallet, or treat code review as live acceptance.

### Hosted profile — deployment contract only

Hosted mode requires `PILOT_DEPLOYMENT_PROFILE=hosted`, an exact normalized
HTTPS `PILOT_PUBLIC_ORIGIN`, an HTTPS non-loopback `HARBOR_URL`, and
`NEXT_PUBLIC_DEV_SIGNER=0`. This repository does not claim a working public
onboarding flow or production deployment.

## Architecture

```text
Browser
  ├─ Chat / typed intent / approval UI
  ├─ Map / Portfolio / Memory
  └─ owner wallet signs an exact transaction (sign-only)
          │
          ▼
Next.js server
  ├─ wallet-bound request proof and profile authority checks
  ├─ typed intent + policy + card state machine
  ├─ server-only Harbor REST client
  └─ wallet-scoped Markdown vault
          │
          ▼
Harbor (separate repository)
  ├─ .2:8791 reviewed build, policy, delegated execution, and relay
  ├─ .2:8792 isolated x402.pay capability with separate payer/state
  └─ validated transaction and payment status
          │
          ▼
XRPL Testnet / Devnet only for authorized execution
```

Key code and documentation:

- [`apps/web`](apps/web) — Next.js routes, UI, server boundaries, and API routes
- [`packages/contracts`](packages/contracts) — hash-checked Pilot/Harbor wire contracts
- [`packages/intents`](packages/intents) — typed intent schemas and builder mapping
- [`packages/agent`](packages/agent) — model tools and card-state orchestration
- [`packages/harbor-client`](packages/harbor-client) — typed REST/MCP clients and fixtures
- [`packages/wallet`](packages/wallet) — wallet providers, sign-only flow, and profile isolation
- [`packages/vault`](packages/vault) — Markdown vault storage and search
- [`e2e`](e2e) — fixture and blocked live-evidence lanes
- [`apps/web/api/x402/RUNBOOK.md`](apps/web/api/x402/RUNBOOK.md) — x402 protocol-test boundary
- [`docs/isolated-x402-profile.md`](docs/isolated-x402-profile.md) — fixed `.2:8792` x402 source contract
- [`docs/diagram-prompts.md`](docs/diagram-prompts.md) — prompts for architecture diagrams
- [`docs/diagram-prompts.md`](docs/diagram-prompts.md) — prompts for architecture diagrams

## Security and recovery invariants

- Pilot never gives the model a signing tool and never holds an owner key on
  the server. External-wallet owner keys remain in the wallet; the test-only
  browser signer is Testnet/Devnet gated and keeps its key browser-local.
- Harbor is a distinct signing trust boundary: it stores encrypted
  limited-purpose delegate keys and standalone payer keys, and unwraps them
  only for an authorized signing operation. Those keys are not owner keys and
  are never browser or model inputs.
- Wallet approval is for one exact rendered transaction. A refresh produces a
  new build that must be rendered and reviewed again; Pilot never auto-signs or
  replays an old attempt.
- Harbor credentials, model keys, and session secrets stay server-side.
- Real model access starts only after the non-broadcast wallet authentication
  proof. The sealed model session expires with and is cryptographically bound
  to that exact 60-minute wallet session, account, and network. Funding,
  trustlines, delegation, and ledger submission remain later optional trading
  setup steps, never authentication prerequisites.
- Shared demo access is default-off. When explicitly configured, an atomic
  server-side ledger reserves the worst-case request charge before provider
  access and retains that charge after cancellation, missing usage, timeout,
  or crash recovery. There is no automatic paid-model or provider fallback.
- The isolated x402 route uses a second named server credential and fixed
  `.2:8792` upstream. It rejects reuse of the trading principal or token, and
  browser requests cannot select either upstream or credential.
- The isolated launcher accepts no arguments, rejects generic dotenv files,
  passes through only a small process environment allowlist, and pins its
  credential and state identities.
- Isolated wallet sessions and acquisition state are deployment-profile bound.
  Legacy state cannot be adopted by the isolated profile, or vice versa.
- Signed-pending attempts are not rebuilt or relayed again. Recovery requires
  validated inclusion or a reviewed non-inclusion proof before requesting a
  fresh build.
- Revocation is complete only after exact validated ledger evidence and local
  terminal cleanup. A UI button, requested transaction, or fixture is not
  revocation evidence.
- The original `.1` session and its browser tab are preservation targets. Never
  hot-update, refresh, migrate, copy, or reuse them for the `.2` profile.
- Mainnet execution, perpetual-futures execution, automatic funding, and
  automatic signing are prohibited.

## Test commands

```bash
# TypeScript packages, scripts, and E2E configuration
pnpm typecheck

# Unit and lane-safety tests
pnpm test

# Eight deterministic browser fixture flows
pnpm test:e2e:fixture

# Production compilation
pnpm --filter web build
```

The following commands are deliberately non-green because their live evidence
is unimplemented:

```bash
PILOT_E2E_ALLOW_HOSTED_READ=1 \
PILOT_E2E_BASE_URL=http://127.0.0.1:3004 \
pnpm test:e2e:hosted-read

PILOT_E2E_ALLOW_AUTHENTICATED_LIVE=1 \
PILOT_E2E_NETWORK=testnet \
PILOT_E2E_BASE_URL=http://127.0.0.1:3004 \
pnpm test:e2e:authenticated
```

Their nonzero `BLOCKED` result is correct. Do not weaken the honest skipped
labels, fabricate evidence, or add an override that can report zero assertions
as passing.

## Known limitations

- No production or Mainnet execution is accepted.
- Public onboarding is not available.
- Live owner binding, funding, signing, trading, revocation, and x402 require
  explicit action-time authorization and evidence; none is implied by CI.
- The isolated x402 code is source-reviewed, but its capability, payer,
  funding, listeners, and `402 → payment → 200` result are not live-accepted.
- Owner-wide vault-position discovery is unavailable because Harbor has no
  supported owner-wide discovery operation.
- Official Testnet RLUSD acquisition depends on real test-network liquidity;
  `tUSD` and other demo assets are not substitutes.
- The isolated macOS runtime remains paused for the administrator loopback
  alias handoff.


## Credits

Pilot preserves its product branding and required third-party notices.

### Dependencies

| Project | Use | License / source |
| --- | --- | --- |
| [Next.js](https://nextjs.org/) and [React](https://react.dev/) | App Router web application | MIT |
| [Tailwind CSS](https://tailwindcss.com/) and [shadcn/ui](https://ui.shadcn.com/) | Styling and accessible UI primitives | MIT |
| [class-variance-authority](https://cva.style/), [clsx](https://github.com/lukeed/clsx), [tailwind-merge](https://github.com/dcastil/tailwind-merge), and [tw-animate-css](https://github.com/Wombosvideo/tw-animate-css) | shadcn/ui composition and utility-class handling | Apache-2.0 / MIT; see projects |
| [Lucide](https://lucide.dev/) | Interface icons | ISC |
| [Geist](https://vercel.com/font) Sans and Mono | Interface typefaces (self-hosted variable woff2 in `apps/web/app/fonts`) | SIL OFL 1.1 |
| [cryptocurrency-icons](https://github.com/spothq/cryptocurrency-icons) | XRP mark on Portfolio token tiles (inlined SVG path) | CC0 1.0 |
| Ripple USD (RLUSD) logo, via [cryptologos.zenobank.io](https://cryptologos.zenobank.io/logo/ripple-usd) | RLUSD mark on Portfolio token tiles (inlined SVG path) | Trademark of Ripple; used only to identify the token |
| [Motion](https://motion.dev/) (Framer Motion) | Interface animation | MIT |
| [Vercel AI SDK](https://ai-sdk.dev/), [Amazon Bedrock Provider](https://ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock), and [OpenRouter AI SDK Provider](https://github.com/OpenRouterTeam/ai-sdk-provider) | Agent streaming, tool calls, and model access | Apache-2.0 / MIT; see projects |
| [Zod](https://zod.dev/) | Runtime schemas and TypeScript validation | MIT |
| [xrpl.js](https://js.xrpl.org/) | XRP Ledger JSON-RPC and WebSocket client | ISC |
| [viem](https://viem.sh/) | Strict ABI, receipt-event, address, and EIP-712 validation for the default-off XRPL EVM Testnet AP4M event adapter | MIT |
| [AWS SDK for JavaScript v3](https://github.com/aws/aws-sdk-js-v3) | Default-off AgentCore Runtime/Gateway invocation and conditional DynamoDB replay fencing for the bounded read-only research lane | Apache-2.0 |
| [esbuild](https://esbuild.github.io/) | Deterministic local Lambda bundle construction for the optional AgentCore runtime package | MIT |
| [xrpl-connect](https://github.com/XRPL-Commons/xrpl-connect) | Owner-wallet connection and sign-only approvals | See project |
| [Ledger Device Management Kit](https://github.com/LedgerHQ/device-sdk-ts), XRP signer kit, WebHID and Speculos transports | Sign-only hardware and virtual-device owner approvals | Apache-2.0 |
| [RxJS](https://rxjs.dev/) | Ledger Device Management Kit observable transport | Apache-2.0 |
| [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) | Streamable HTTP MCP client | MIT |
| [gray-matter](https://github.com/jonschlinkert/gray-matter) | Markdown frontmatter | MIT |
| [MiniSearch](https://github.com/lucaong/minisearch) | Local vault and catalog search | MIT |
| [simple-git](https://github.com/steveukx/git-js) | Filesystem-vault Git commits | MIT |
| [Octokit](https://github.com/octokit/octokit.js) | GitHub-backed vault commits | MIT |
| [Vitest](https://vitest.dev/) | Unit tests | MIT |
| [Playwright](https://playwright.dev/) | End-to-end tests | Apache-2.0 |
| [tsx](https://tsx.is/) | TypeScript script runner | MIT |
| [TypeScript](https://www.typescriptlang.org/), [Node.js](https://nodejs.org/), and [pnpm](https://pnpm.io/) | Language, runtime, and workspace package manager | Apache-2.0 / MIT; see projects |
| [x402-xrpl](https://pypi.org/project/x402-xrpl/) and [FastAPI](https://fastapi.tiangolo.com/) | Testnet x402 merchant function | See projects / MIT |
| [LedgerHQ XRP app 2.8.2](https://github.com/LedgerHQ/app-xrp) | Apache-2.0 XRP app fixture used by the local Speculos conformance kit | Apache-2.0 |
| [xrpl-py](https://github.com/XRPLF/xrpl-py) | Merchant-side XRPL transaction and payment-channel interoperability | ISC |
| [cryptography](https://cryptography.io/) | Merchant-side ES256 and Ed25519 verification for Verifiable Intent and Web Bot Auth | Apache-2.0 / BSD-3-Clause |
| [Verifiable Intent v0.1.0 verifier](https://github.com/agent-intent/verifiable-intent/tree/1dc3d4189512041fb3d0f8348fe100dfe25ced91) | Pinned, provenance-recorded verification subset used by the AP4M merchant | Apache-2.0 |

### Public protocols, services, and references

| Reference | How Pilot/Harbor uses it |
| --- | --- |
| [XRP Ledger documentation](https://xrpl.org/docs/) and [XRPL Docs MCP](https://xrpl.org/resources/dev-tools/ai-tools) | Canonical protocol, transaction, amendment, and API documentation |
| [XRPL Permission Delegation](https://xrpl.org/docs/concepts/accounts/permission-delegation), [permission values](https://xrpl.org/docs/references/protocol/data-types/permission-values), and [delegate samples](https://github.com/XRPLF/xrpl-dev-portal/tree/master/_code-samples/delegate-permissions/) | Delegated execution model and transaction construction |
| [XRPL trading skill](https://xrpl.org/docs/agents/xrpl-trading-skill) and [XRPL developer skills](https://github.com/XRPLF/xrpl-dev-portal/tree/master/.claude/skills/xrpl-skills/) | Transaction patterns and preflight guardrails |
| [Ripple lending reference app](https://github.com/ripple/xrpl-reference-app-lending-sav) | Public reference for XLS-65/66 Devnet transaction shapes |
| [xrpl.to API](https://api.xrpl.to/v1), [XRPSCAN API](https://docs.xrpscan.com/api-documentation/amm/pools), and [Bithomp API](https://docs.bithomp.com/) | Token and AMM indexing, with documented fallbacks |
| [xrpldashboard MCP](https://mcp.xrpldashboard.com/mcp) | Optional amendments and AMM TVL data |
| [RLUSD developer documentation](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl) | Stablecoin issuer and trust-line reference |
| [x402 on XRPL](https://xrpl.org/docs/agents/agentic-payments-x402) | Testnet premium-data payment flow |
| [Cloudflare Code Mode](https://blog.cloudflare.com/code-mode/) and [Dynamic Workers](https://developers.cloudflare.com/changelog/post/2026-03-24-dynamic-workers-open-beta/) | Public architectural references for Harbor's sandboxed execution |
| [OpenRouter](https://openrouter.ai/docs/) | Bring-your-own-model OAuth and capped demo-model access |
| [Hyperliquid API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint) | Read-only XRP perpetual-market metadata; never execution |
| [Obsidian](https://help.obsidian.md/) and [Vercel](https://vercel.com/docs) | Markdown-vault interoperability and application hosting |
| [Mastercard Open Finance US](https://developer.mastercard.com/open-finance-us/documentation/) | Mock-first human-verification contract and event-day sandbox integration |
| [Mastercard Developers MCP and Agent Toolkit](https://developer.mastercard.com/ai/) | Federated Mastercard product discovery; MCP `0.1.7` and toolkit `0.1.6` were the referenced interfaces |
| [Mastercard Level 3 Agentic Commerce guide](https://developer.mastercard.com/merchant-cloud/documentation/tutorials-and-guides/agentic-commerce-guide/23/index.md) | Merchant API shapes and identity → intent → payment validation order |
| [Verifiable Intent](https://github.com/agent-intent/verifiable-intent) | L1/L2/L3 mandate chain and Apache-2.0 reference verifier |
| [RFC 9421 HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421), [Web Bot Auth](https://webbotauth.org/), [`web-bot-auth`](https://www.npmjs.com/package/web-bot-auth), and [`http-message-signatures`](https://www.npmjs.com/package/http-message-signatures) | Agent HTTP identity protocol and implementation references; the current merchant verifier uses `cryptography` rather than importing these JavaScript packages |
| [`@sd-jwt/core`, `@sd-jwt/sd-jwt-vc`, and `@sd-jwt/crypto-nodejs`](https://github.com/openwallet-foundation-labs/sd-jwt-js) | SD-JWT interoperability references; the shipped merchant verifier is the pinned Verifiable Intent Python subset above |
| [Mastercard Agent Pay for Machines](https://www.mastercard.com/us/en/business/artificial-intelligence/mastercard-agent-pay/agent-pay-for-machines.html) | AP4M discover/authorize/execute/settle model; the partner-gated AP4M rail is not connected |
| [AP4M XRPL EVM event integration guide](https://hackathon.ap4m.build/integration-guide) and [public event config](https://hackathon.ap4m.build/public/config) | Exact Testnet chain, allowlisted contract and RLUSD-token profile used by the default-off mock-only event adapter |

No source code is imported from Stellar projects or unrelated wallet/agent
implementations.

## Mastercard AP4M demo

Pilot and Harbor apply Mastercard's agentic-commerce artifacts to an XRPL
Testnet payment rail: Open Finance verifies the human, Verifiable Intent records
one bounded mandate, Web Bot Auth identifies Harbor to a merchant, and the
merchant validates identity → intent → XRPL payment in the Level 3 order.
Credential-gated exact payments and collateral-backed payment-channel claims
are designed to settle on XRPL Testnet; no mock/offline result is live ledger
evidence, and no payment is represented as moving on Mastercard's network.

The default engineering mode is credential-free and mock-first:

```bash
MASTERCARD_OF_MODE=mock HARBOR_MOCK=1 pnpm typecheck
MASTERCARD_OF_MODE=mock HARBOR_MOCK=1 pnpm test
MASTERCARD_OF_MODE=mock pnpm tsx scripts/mastercard/of-smoke.ts
```

The full local reset, multi-process demo stack, safety scenarios, and two-run
rehearsal are orchestrated under `scripts/ap4m-demo/` after the Wave 4 packages
are combined. They are Testnet-only operations and are not part of the default
offline lane. See [the AP4M runbook](docs/ap4m.md) for the architecture,
mandatory stand-in labels, mock-to-sandbox handoff, event-day gates, and exact
demo commands.
