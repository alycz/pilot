# NEAR integration boundary

Pilot preserves its existing model-agnostic MCP/REST harness and XRPL lane.
NEAR support is added as typed adapters, not as a replacement runtime and not
as a claim that every catalogued venue is executable.

## Implemented in source

- Harbor operations `near.intents.tokens`, `near.intents.quote`, and
  `near.intents.status` use the fixed official 1Click origin.
- `near.intents.quote` accepts only an `EXACT_INPUT`, public, dry request in the
  initial slice. It verifies the provider signature with the pinned official
  SDK and binds the complete echoed request before returning a Base58 quote
  hash. A dry quote has no deposit address and is never executable approval.
- Status reads carry the provider deposit address and memo together, verify the
  nested quote signature, and preserve provider-reported settlement states.
- Shared contracts distinguish provider signature verification from Pilot's
  principal-bound approval digest. The latter commits to exact asset IDs,
  atomic amounts, recipient, refund address, deposit metadata, policy,
  versioned idempotency key, approval expiry, and provider refund-start
  deadline. The digest uses an explicit `pilot.near-intents.approval.v2`
  domain separator.
- Server-side wallet authorization contracts bind one authenticated Pilot
  principal to one NEAR account and network in a short-lived,
  authenticated-encrypted authorization artifact. Cross-principal,
  cross-account, expired, and wallet-change cases fail closed. No route
  currently verifies wallet control or issues a NEAR session, so this is an
  integration boundary rather than a live login claim.
- `@pilot/near-attempt-store` provides a single-process internal-test store
  with exact replay/conflict handling, atomic per-principal/per-asset budget
  reservation, compare-and-swap revisions, durable reconciliation evidence,
  and crash/restart fixtures. Unknown outcomes continue counting against the
  budget and can never authorize automatic resubmission. The local file
  adapter is explicitly not a hosted or multi-replica database.
- Harbor now also contains a review-only D1 persistence adapter and byte-identical
  canonical/Free-QuickJS `0018_near_attempt_store.sql` migrations. Hosted
  counters are scoped by tenant, principal, network, and asset; atomic amounts
  remain canonical decimal text and are updated with exact Worker `BigInt` plus
  D1 value/revision CAS triggers. Wallet changes cannot create a fresh budget
  bucket. The migrations are hash-pinned but have not been applied, and no
  route currently instantiates the adapter.
- A provider-neutral NEAR wallet facade and review card exist with signing and
  execution disabled by default. They contain no submit or broadcast method.
- Same-origin NEP-413 routes bind an exact sealed server principal
  authorization, account, mainnet network, recipient, 32-byte nonce, and
  expiry. In explicit `verify` mode, Pilot reconstructs the exact tagged Borsh
  payload with callback URL absent, verifies SHA-256/Ed25519 locally, and uses a
  fixed, bounded NEAR mainnet RPC query to require that the exact account/key has
  `FullAccess`. A dedicated Harbor D1 replay store then atomically consumes an
  opaque scope bound to principal, account, network, authorization ID, and
  recipient. Missing RPC or replay storage fails closed; no signature alone is
  treated as wallet control.
- Canonical/Free-QuickJS `0019_near_wallet_proof_replay.sql` migrations add the
  dedicated replay table without modifying the already hash-pinned `0017`
  migration. The migration is review-only and has not been applied. A successful
  proof clears its challenge and returns a wallet-control confirmation, but does
  not mint a reusable NEAR login cookie or enable execution.
- `/demo/near-intents`, linked from the existing Integrations menu, provides an
  explicitly configured live read-only path for token inventory and verified
  dry quotes plus a visibly separate fixture-only approval/status walkthrough.
  Provider errors never fall back to fixtures, and neither path can enable
  execution.
- `@pilot/near-chain-signatures` pins `chainsig.js` 1.1.16 for a narrow NEAR
  Testnet -> XRP Testnet native-payment preparation/finalization boundary. It
  exposes no broadcast or generic signing method and remains off until an owner
  wallet and external Testnet acceptance lane are separately integrated. The
  package root does not evaluate `chainsig.js`; the audited runtime is reachable
  only through the explicit `/official` subpath.
- The NEAR AI OpenAI-compatible chat adapter is installed and wired behind
  `NEAR_AI_ENABLED=1`, and remains default-off. Chat resolves only the exact
  configured model after the public catalog reports it ready with native
  `tools` support. The existing OpenRouter demo path is unchanged; NEAR AI
  account selection currently reuses the wallet-bound OpenRouter OAuth session.
  Privacy receipts are derived from operator configuration, never model output,
  and always report runtime attestation as unverified. Live model-catalog
  discovery, fixed-origin read-only NEAR RPC, and an Earn discovery flow are
  also implemented. Earn uses the standard tokens -> dry quote -> optional
  existing-settlement status path; it has no invented deposit endpoint.

## Not accepted or enabled

- 1Click has no testnet. A live dry quote was verified, but no executable
  quote, funded settlement, mainnet deposit, signed intent, limit order,
  wallet signature, or transaction submission was performed while
  implementing this slice.
- `SUCCESS` is provider-reported unless destination evidence is independently
  verified. Unknown or missing status never proves non-execution and never
  authorizes an automatic replacement payment.
- A NEAR function-call key allowance pays gas; it is not a token spending cap.
- NEAR AI privacy is operator-declared metadata until its attestation and E2EE
  path receive separate acceptance. It is not wired into live chat by default.
- Remote D1 acceptance, application of migration `0019`, a real-wallet NEP-413
  acceptance run, funded settlement reconciliation, and a reviewed mainnet
  execution lane remain future gates.
  The local D1 stand-in covers separate adapter instances and CAS contention,
  but remote migration apply, backup/rollback rehearsal, tenant isolation
  review, retention/observability, and real multi-worker tests remain required.
- The NEAR AI chat path remains default-off. No model completion was attempted;
  a separately authorized live acceptance run must verify the configured API
  key, model access, tool behavior, billing boundary, and provider privacy or
  attestation evidence before production claims are made.
- IronHub is not integrated. Its current artifacts target the IronClaw WIT/WASM
  runtime and include broader write-capable surfaces than this slice needs.
  Shade Agents is deprecated and intentionally excluded.

## Configuration

All credentials stay server-side. See `.env.example` and
`services/harbor/.env.example`. Empty or disabled configuration fails closed.
The browser cannot select provider origins, inject credentials, or turn on
execution.

## Read-only acceptance evidence

On 2026-10-26, without credentials, the official token endpoint returned HTTP
200 with 208 tokens across 37 current chain codes. That live response exposed
`qtc` and `abs` codes not present in the earlier rendered enum, so the adapter
was updated to accept those provider-observed values and regression-tested.
The bounded adapter then obtained and verified a real `dry: true` wNEAR -> USDC
quote: the provider signature passed, the Base58 quote hash was 44 characters,
and no deposit address was returned. This proves only read/dry-quote
connectivity at that moment, not route longevity, liquidity, settlement, or
execution readiness.

The public NEAR AI model catalog also returned HTTP 200 (61 models reported,
15 marked ready at the time of the check), and NEAR mainnet RPC `status`
returned HTTP 200 with `syncing: false`. No model completion, wallet action,
transaction, or paid operation was performed.

The Harbor production dependency lock was refreshed from `body-parser` 2.3.0
to 2.4.0 and `fast-uri` 3.1.8 to 3.1.9. `npm audit --omit=dev` reported zero
production advisories after that refresh. The optional `chainsig.js` 1.1.16
tree still contains known transitive advisories and remains isolated behind the
explicit, disabled `/official` import until upstream patches and external
Testnet acceptance are available.

The workspace production audit removed both critical findings by upgrading
`simple-git` to 4.0.2, and removed the Next/PostCSS and MCP/body-parser high
findings with scoped overrides. At `ba88614`, five baseline high advisories
remain: Undici 5.29.0 (`GHSA-vrm6-8vpv-qv8q`,
`GHSA-v9p9-hfj2-hcw8`, `GHSA-vxpw-j846-p89q`), its Busboy 2.1.1 dependency
(`GHSA-x8mw-p69m-v3mx`), and Zod 3.25.76
(`GHSA-mrhx-c7xc-m3w5`). The affected Undici graph is
`ai`/Bedrock/NEAR OpenAI-compatible -> `@ai-sdk/provider-utils` -> Undici;
Zod 3 is direct in web, contracts, and Harbor client and is runtime-reachable.
All five vulnerable versions were already locked at baseline `cb4f28e`; this
branch adds consumers of those existing lines. A scoped Undici 6.29.1 trial
passed focused runtime tests but failed Next production output tracing, so it
was not retained. Zod requires a fixture-backed v4 migration rather than a
cross-major override. This branch is not a production deployment
recommendation until those findings and the acceptance gates above are closed.
