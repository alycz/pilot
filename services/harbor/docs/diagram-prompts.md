# Harbor diagram prompt pack

These prompts are grounded in the destination source. Give the diagram tool the cited source files and require it to flag ambiguity instead of inventing behavior.
with the selected prompt. Ask it to flag any ambiguity instead of inventing
behavior.

## Delivery requirements for every diagram

Produce both:

1. a standalone, editable SVG with selectable text; and
2. the editable diagram source, preferably Mermaid, otherwise draw.io XML.

Use a 16:9 landscape canvas, a color-blind-safe palette, WCAG AA contrast, and
16 px minimum body text. Include a legend, concise alt text, and a small footer
listing the repository files used as sources. Separate trust boundaries and
distinguish reads, durable writes, unsigned transaction construction, signing,
and XRPL submission visually. Mark preparation-only or unverified operational
state explicitly. Do not include keys, tokens, addresses, signed blobs, hosted
URLs, or unsupported claims. Passing offline tests is not live acceptance.

## Prompt 1 — System architecture

Create a polished Harbor system architecture diagram. Show MCP and REST clients
entering one Cloudflare Worker through route selection and bearer
authentication, producing a principal-scoped operation context. Split MCP into
catalog `search` and sandboxed `execute`; show the Dynamic Worker / QuickJS
execution boundary with no direct outbound network access. Show REST direct
invocation. Rejoin both paths at the shared Harbor provider guards, then show
the operation registry, D1 durable state and policy, transaction lifecycle, and
bounded XRPL/document/indexer adapters. Add the scheduled hosted watcher as a
separate cron entry point into the same durable link state. Label these bounds:
MCP 30 operation calls, 10-second execution deadline, 24 KiB final output;
REST 1 MiB request and response; XRPL JSON-RPC 4 MiB response. Note that the
generic WebSocket transport does not yet have the equivalent response cap.

Sources: `src/server.ts`, `src/mcp/tools.ts`, `src/rest.ts`,
`src/executor/run.ts`, `src/executor/quickjs.ts`,
`src/executor/providers.ts`, `src/catalog/registry.ts`, `src/exec/store.ts`,
`src/exec/watcher.ts`, and `src/cron.ts`.

If deployment variants are included, draw both x402 signers as separate trust
domains: legacy `127.0.0.1:8791` and isolated `127.0.0.2:8792`. The isolated
x402 process has a dedicated principal, credential, payer, D1 tree, and
inspector at `127.0.0.2:9232`; it is not part of isolated trading at
`127.0.0.2:8791`. Mark both signing profiles and all live outcomes unverified.

## Prompt 2 — MCP and REST shared-core flow

Create a sequence/flow diagram comparing one MCP operation call with one REST
operation call. MCP must show `search`, then `execute` script evaluation, then
the `harbor.*` proxy. REST must show `POST /api/ops/{operation}` with a direct
JSON argument body. On both paths show route-level size checks, named bearer
authentication, principal propagation, profile/network/operation allowlists,
schema validation, `createHarborProvider`, registry invocation, redacted stable
response envelopes, and response-size enforcement. Emphasize that transport
choice does not bypass shared authorization or principal-scoped D1 state.

Sources: `src/server.ts`, `src/mcp/tools.ts`, `src/rest.ts`,
`src/executor/providers.ts`, `src/catalog/registry.ts`, `src/guard/envelope.ts`,
`src/guard/error.ts`, and `src/guard/validation.ts`.

## Prompt 3 — Authorization, signing, and reconciliation

Create a security-focused transaction lifecycle diagram. Begin with a builder
creating and simulating an unsigned transaction and persisting the build. For
`xrpl_execution_v2`, show the immutable build revision, unsigned transaction
digest, economic fingerprint, exact inclusion window, remaining-ledger gate,
approval expiry, and optional balance invariant. Then show the idempotency
claim and policy decision branches: blocked, strict owner approval, or delegated
execution. On the delegated branch, place the atomic daily-USD reservation and
immutable execution snapshot before delegate unwrap and signing. On the owner
branch, show approval creation, `tx.approvalPreflight`, owner sign-only, durable
hash/relay claim, and the sole submission path. For unknown outcomes, show
exact-hash inclusion winning; otherwise require a validated head beyond the
immutable last-ledger sequence and complete bounded non-inclusion proof before
terminal recovery. Include `tx.approvalReconcile` as a narrow burn-and-fresh-
build path, not replay or resubmission. Put the owner key outside Harbor's trust
boundary. Explicitly state that simulation is not authorization and that
Mainnet signing/submission is rejected.

Sources: `src/ops/tx-exec.ts`, `src/exec/build.ts`, `src/exec/policy.ts`,
`src/exec/store.ts`, `src/exec/keys.ts`, `src/exec/sign.ts`,
`src/exec/submit.ts`, `src/executor/errors.ts`, `src/ops/tx.ts`, and
`docs/execution-lifetime-v2-contract.md`.

## Prompt 4 — Isolated local onboarding and trading

Create a deployment and handoff diagram for the exact isolated-v1 local setup.
Show the browser speaking only to Pilot at `127.0.0.2:3003`; Pilot calls Harbor
server-to-server at `127.0.0.2:8791` with the exact uncanonicalized Host header
and a named bearer. Show two mutually exclusive, sequential Harbor profiles:
onboarding first, then stopped, then trading; onboarding is restarted only for
lifecycle work such as revocation. They share only the exact isolated-v1
credential file and D1 state, while markers, configs, logs, operation
allowlists, and durable build origins remain distinct. List the six trading
operations and fourteen onboarding operations exactly as documented in the
README. Show rejection of localhost, `127.0.0.1`, `::1`, alternate ports,
forwarded authority, cross-profile origins, and mixed markers. Label credential
creation, service startup, wallet actions, funding, signing, and revocation as
operator-gated actions not performed by documentation or offline tests. Mark
startup of these isolated-v1 `127.0.0.2` services as paused for the
administrator-alias handoff and the older delegation as unresolved. Add a
clearly separated side box for the legacy standalone x402 signer on
`127.0.0.1:8791`, with its own credential, D1 state, payer, merchant, and
non-mutating probe. Add the accepted-source isolated x402 process at
`127.0.0.2:8792`, reached server-to-server from Pilot through its own named
bearer and kept separate from trading `.2:8791`. Its source and fixture tests
are accepted, but provisioning, startup, payments, and live acceptance remain
unperformed and operator-gated.

Sources: `scripts/dev-local-trading-isolated-v1.mjs`,
`scripts/dev-local-trading-isolated-v1-onboarding.mjs`,
`wrangler.local-trading-isolated-v1.jsonc`,
`wrangler.local-trading-isolated-v1-onboarding.jsonc`,
`src/local-trading-isolated-v1.ts`,
`src/local-trading-isolated-onboarding-v1.ts`, `src/server.ts`,
`src/executor/providers.ts`, and
`docs/local-trading-isolated-v1-contract.md`.

## Prompt 5 — Legacy standalone x402 signing flow

Create a security and topology diagram for the reviewed legacy local x402
profile. Put Harbor at `127.0.0.1:8791` and the fixed merchant at
`127.0.0.1:8000`; keep both completely separate from isolated trading at
`127.0.0.2:8791` and isolated x402 at `127.0.0.2:8792`. Show the exact external
secret file, isolated
`.wrangler/harbor-local-x402` D1 state, named principal, owner policy namespace,
dedicated Testnet payer, and fixed merchant receiver. Explain custody exactly:
Harbor stores the payer seed only as AES-GCM ciphertext and can unwrap it for
the guarded signing flow; the user owner key and merchant receiver private key
remain outside Harbor.

Show two distinct paths. First, the credential-free non-mutating
`GET /local/x402/probe` performs one fixed GET, follows no redirect, cancels the
body, and reports reachability/status/content type only. Second, `x402.pay`
validates the exact T54 v2 challenge, fixed resource and receiver, atomically
reserves amount plus fee, signs once, persists before delivery, and releases
merchant data only after independent validated XRPL proof. Annotate the
100,000-drop payment cap, 100-drop fee cap, and 1,000,000-drop UTC-day cap.
Mark credential creation, payer creation/funding, service startup, and signing
as separately authorized actions. State that this legacy `.1` profile remains
unchanged and is not the isolated Pilot `.2` route.

Sources: `scripts/dev-local-x402.mjs`, `scripts/dev-local.mjs`,
`scripts/provision-local-x402.ts`, `wrangler.local-x402.jsonc`,
`src/local-x402.ts`, `src/exec/x402-runtime.ts`, `src/exec/x402-pay.ts`,
`src/exec/x402-payer-store.ts`, `src/exec/x402-local-secret-file.ts`, and
`src/x402-contract.ts`.

## Prompt 6 — Isolated x402 authority and evidence gates

Create a security and topology diagram for the accepted-source, offline-only
isolated x402 v1 profile. Show Pilot at `127.0.0.2:3003` calling the dedicated
Harbor REST process at `127.0.0.2:8792`, with exact raw Host, a dedicated named
bearer, and inspector `127.0.0.2:9232`. Keep isolated trading/onboarding at
`127.0.0.2:8791`, the legacy x402 process at `127.0.0.1:8791`, and the fixed
merchant at `127.0.0.1:8000` in distinct trust domains. Show that isolated x402
accepts only `x402.pay`, has its own credential-bound external absolute D1 root,
credential file, Pilot capability file, principal, payer, immutable root marker,
and log, and rejects forwarded authority, alternate hosts, checkout-relative or
trading-root persistence, trading markers, redirects, and caller-selected
targets.

Add a provisioning precondition panel. The operator captures the unmodified
public `data` results from `account.status` and `onboarding.readiness` into the
fixed private evidence file using the checked-in template. The exact CLI uses
`--trading-delegate`, not `--trading-payer`. Before migrations, D1 open, secret
publication, payer generation, or faucet access, Harbor verifies the CLI and
evidence agree on owner and active Testnet delegate, the exact permissions and
readiness checks pass, and the x402 principal/payer are separated from trading
authority, owner, merchant, and active delegate. Show both private output files
published exclusively with native ACL checks.

Add an initialize-versus-resume state lane. `initialize` requires an explicitly
approved absent external leaf, applies the isolated migrations, validates the
real Miniflare D1 layout and final x402 schema, then writes the marker once.
`resume` and the launcher require the credential, marker, state root, Testnet
profile, D1 ID/name, sole direct D1 payload, and schema to agree; they never
create or migrate state. Label
`${HARBOR_PRIVATE_STATE_ROOT:?set HARBOR_PRIVATE_STATE_ROOT}/harbor-local-x402-isolated-v1` as a
proposal awaiting approval, not an active path. Mark actual root creation,
evidence capture, provisioning, credential creation, funding, service startup,
payment, and live ledger acceptance as unperformed and separately authorized.

Sources: `docs/local-x402-isolated-v1-contract.md`,
`scripts/dev-local-x402-isolated-v1.mjs`,
`scripts/local-x402-isolated-state.mjs`,
`scripts/provision-local-x402-isolated-v1.ts`,
`wrangler.local-x402-isolated-v1.jsonc`,
`config/harbor-local-x402-isolated-v1.env.template`,
`config/pilot-isolated-trading-delegate-evidence-v1.json.template`,
`src/local-x402-isolated-v1.ts`, `src/exec/x402-isolated-secret-file.ts`,
`src/exec/x402-trading-delegate-evidence.ts`, `src/exec/x402-provisioner.ts`,
`src/ops/x402.ts`, and `src/server.ts`.

## Prompt 7 — Watcher, suspension, and owner revocation

Create a state-machine diagram for hosted delegated-transaction monitoring and
revocation. Show the scheduled Worker calling `runWatcher`, scanning active
links with validated `account_tx`, filtering Harbor-known transaction hashes,
and treating a foreign delegated transaction as evidence. Show durable evidence
recording and local suspension before Harbor prepares an unsigned empty-
permission `DelegateSet`. Make clear that Harbor cannot sign with the owner key:
an operator must review, owner-sign, submit, and then wait for validated
`account.status: revoked`. Distinguish `suspended` from on-ledger `revoked`.
Show malformed, unvalidated, partial, or unknown ledger state failing closed.
Mark local trading cron as disabled. Add a visible operational note that the
older delegation is unresolved and revocation is not complete.

Sources: `src/cron.ts`, `src/exec/watcher.ts`, `src/ops/account.ts`,
`src/exec/delegation.ts`, `src/exec/store.ts`, `src/adapters/xrpl-rpc.ts`,
`test/watcher-suspension.test.ts`, and `test/account.test.ts`.

## Review checklist

- Every named operation, limit, state, and trust boundary is traceable to a
  cited source file.
- The graphic never implies that Harbor holds an owner seed or signs Mainnet.
- Operational delegate and x402 payer key custody is shown as wrapped at rest
  and available only to its guarded signing path, not described as keyless.
- `health` is not presented as onboarding readiness.
- `suspended` is not presented as on-ledger revocation.
- Offline, mocked, skipped, fixture, or no-socket evidence is not labeled live
  acceptance.
- The SVG has selectable text, useful alt text, and remains understandable in
  grayscale and at 100% zoom.
