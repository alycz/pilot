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
- `near.intents.executable-quote.review` has two separate, default-off exact-route
  profiles. The existing local-only `arb-usdc-to-wnear-manual-v1` profile covers
  canonical USDC on Arbitrum One -> wNEAR on NEAR mainnet. The hosted-default-off
  `near-native-to-arbitrum-usdc-v1` profile covers native NEAR owner funding ->
  canonical USDC on Arbitrum One. For that hosted profile, the 1Click request
  uses the catalog asset `nep141:wrap.near`, while the owner instruction is an
  exact native-NEAR transfer to the returned NEAR deposit account and 1Click
  manages wrapping. The destination is chain ID `42161`, token contract
  `0xaf88d065e77c8cc2239327c5edb3a432268e5831`, with six decimals. Both profiles
  dynamically attest their exact token records, request `dry: false`, verify
  the provider signature and full request echo for live results, reject memo
  routing, and bind the exact amount, minimum output, recipient, refund address,
  deposit address, correlation ID, quote hash, provider refund-start deadline,
  and a separate five-minute review freshness window. They return manual
  owner-funding instructions only; no wallet transaction is built, signed,
  funded, or sent.
- Hosted native-route review distinguishes deterministic fixture output from
  live provider output. Fixture output is labeled `source: "fixture"`, carries
  `provider_signature_verified: false`, and is not admissible to reservation.
  Live output is labeled `source: "live"`, requires the server-side 1Click key,
  and carries the verified provider quote binding. Neither form is a completed
  swap or permission to fund.
- The same-origin web proxy requires an active sealed NEAR principal
  authorization with the required approval/executable-review scopes. For the
  existing reverse route, its mainnet account is the exact NEAR recipient. For
  the native route, its account is the exact source/refund account while the
  separately reviewed recipient is an Arbitrum address. This server-issued
  principal binding is not by itself a fresh wallet-control proof or economic
  approval. Independent Pilot and Harbor flags remain off by default.
- Shared contracts distinguish provider signature verification from Pilot's
  principal-bound approval digest. The latter commits to exact asset IDs,
  atomic amounts, recipient, refund address, deposit metadata, policy,
  versioned idempotency key, approval expiry, and provider refund-start
  deadline. The digest uses an explicit `pilot.near-intents.approval.v2`
  domain separator.
- Server-side wallet authorization contracts bind one authenticated Pilot
  principal to one NEAR account and network in a short-lived,
  authenticated-encrypted authorization artifact. Cross-principal,
  cross-account, expired, and wallet-change cases fail closed. The default-off
  NEP-413 route can verify one wallet-control proof after hosted replay
  consumption, but it does not issue a reusable NEAR session, so this remains
  an integration boundary rather than a live login claim.
- `@pilot/near-attempt-store` provides a single-process internal-test store
  with exact replay/conflict handling, atomic per-principal/per-asset budget
  reservation, compare-and-swap revisions, durable reconciliation evidence,
  and crash/restart fixtures. Unknown outcomes continue counting against the
  budget and can never authorize automatic resubmission. The local file
  adapter is explicitly not a hosted or multi-replica database. Its v2 local
  lifecycle also binds owner-reported Arbitrum funding, origin verification,
  provider observations, and independent NEAR destination evidence. Provider
  `SUCCESS`, `REFUNDED`, or `FAILED` alone is nonterminal.
- `near.intents.owner-funded.reserve` is a hosted-default-off admission handler
  for the native-NEAR -> Arbitrum-USDC profile. It accepts only an exact live,
  provider-signature-verified quote binding plus a fresh principal/account-bound
  economic approval. It re-verifies the quote hash and approval digest, applies
  a server-configured atomic budget limit, and atomically records or replays the
  exact reservation in D1. The browser cannot choose or weaken that budget. Its
  result always says `execution_enabled: false` and
  `manual_owner_funding_only: true`; it has no key, signature, transaction, or
  broadcast output and does not fund the deposit.
- `near.intents.owner-funded.reconcile` is a separate hosted-default-off,
  read-only evidence handler for an already owner-funded native route. Its
  source stage uses Pilot-pinned NEAR mainnet RPC to require one finalized,
  exact native transfer from the approved owner to the quoted deposit account.
  Its settlement stage persists signed/bound provider status first, then uses
  provider destination hashes only as bounded hints and independently requires
  one finalized canonical-USDC `Transfer` on Arbitrum to the exact reviewed
  recipient for at least the quoted minimum. Unknown, failed, ambiguous, and
  transport outcomes remain held with `safe_to_resubmit: false`. Provider
  `REFUNDED` also remains held because trusted refund discovery and receipt
  verification are not implemented; the operation cannot release on status
  alone. No stage constructs, signs, funds, broadcasts, or retries a transfer.
- Harbor contains a review-only D1 persistence adapter and byte-identical
  canonical/Free-QuickJS migrations `0018_near_attempt_store.sql`,
  `0019_near_wallet_proof_replay.sql`, and
  `0020_near_native_to_arbitrum_usdc_lifecycle.sql`. Migration `0018` adds the
  tenant/principal/account-bound attempt, atomic budget reservation, replay,
  unknown-outcome, and reconciliation-evidence state. Migration `0019` adds
  one-time NEP-413 proof-consumption state. Migration `0020` adds the immutable
  native-NEAR -> canonical-Arbitrum-USDC lifecycle binding and independent
  source, provider-observation, destination-receipt, and refund-receipt states.
  Hosted counters remain scoped by tenant, principal, network, and asset;
  atomic amounts remain canonical decimal text and are updated with exact
  Worker `BigInt` plus D1 value/revision CAS triggers. Wallet changes cannot
  create a fresh budget bucket. All three migrations are checked in for review
  and have not been applied by this work.
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
- A hosted, default-off bootstrap route derives an opaque principal only from
  an active sealed Pilot wallet session and issues a five-minute,
  approval-review-only claim for one asserted NEAR mainnet account. Only after
  the exact NEP-413 proof and durable nonce consumption succeed does the server
  upgrade it to a 15-minute authorization limited to approval review,
  executable-quote review, read-only status, and reservation. Changing or
  renewing the Pilot wallet session invalidates it; the authorization never
  grants an access key or transaction capability.
- Canonical/Free-QuickJS `0019_near_wallet_proof_replay.sql` adds the dedicated
  replay table without modifying the already hash-pinned `0017` migration. A
  successful proof clears its challenge and returns a wallet-control
  confirmation. A bootstrap proof may mint only the short-lived scoped
  authorization above; it does not enable execution.
- `/demo/near-intents`, linked from the existing Integrations menu, provides an
  explicitly configured live read path for token inventory, verified dry
  quotes, exact-route executable review, and exact bound status, plus visibly
  labeled fixtures. Provider errors never fall back to fixtures. The older
  reverse route remains blocked while wNEAR destination-delivery semantics are
  unverified. The native route's review and reserve surfaces remain default-off
  and manual-owner-funded. Near Connect 0.12.0 is wired behind an independent
  default-off browser flag with `autoConnect: false`, one app-supplied executor
  pinned to an immutable repository commit, and no access-key, transaction,
  delegate-action, or broadcast method. The live UI performs the server-required
  bootstrap proof before requesting a quote, then requires a fresh quote-bound
  proof and separate economic approval before durable reservation. No live
  wallet prompt, signing, provider executable quote, transfer, broadcast, or
  funded action was run while implementing it.
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
- The executable-review routes were exercised only with deterministic fixtures.
  The native-route reserve handler and D1 lifecycle exist in source but were not
  accepted against an applied remote migration. Owner-funding instructions are
  not accepted until a fresh live quote, fresh economic approval, durable remote
  reservation, independent source and destination receipt verification, and
  owner-run wallet acceptance all pass. The older reverse route separately
  requires its destination-delivery semantics to be accepted. Pilot budgets
  cannot stop an owner from transferring outside Pilot.
- `SUCCESS` is provider-reported unless destination evidence is independently
  verified. Unknown or missing status never proves non-execution and never
  authorizes an automatic replacement payment.
- Automatic refund release is intentionally unavailable with the current
  official 1Click contract. The status schema exposes only untyped
  `nearTxHashes` / `originChainTxHashes` arrays plus provider-reported
  `refundedAmount` and `refundReason`; it does not identify a refund-specific
  transaction or trusted refund sender. `TransactionDetails` contains only a
  hash and explorer URL. Quote signature verification covers the quote request,
  quote, and timestamp—not later status or `swapDetails` refund metadata. See
  the official [status API](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status),
  [quote-signature contract](https://docs.near-intents.org/integration/distribution-channels/1click-api/verify-quote-signature),
  and [SDK transaction model](https://raw.githubusercontent.com/defuse-protocol/one-click-sdk-typescript/main/src/models/TransactionDetails.ts).
  A coincidental incoming NEAR transfer therefore cannot be distinguished from
  the actual refund strongly enough to release budget. Provider `REFUNDED`
  remains an investigation trigger only: Pilot keeps the attempt UNKNOWN,
  keeps its reservation charged, and never auto-resubmits. Enabling terminal
  refund release requires an official typed refund transaction identity,
  trusted sender/contract semantics, documented post-fee and partial-refund
  amount rules, and independently verified finalized chain evidence.
- A NEAR function-call key allowance pays gas; it is not a token spending cap.
- NEAR AI privacy is operator-declared metadata until its attestation and E2EE
  path receive separate acceptance. It is not wired into live chat by default.
- Remote D1 acceptance, application of migrations `0018`, `0019`, and `0020`,
  a real-wallet NEP-413 acceptance run, funded settlement reconciliation, and a
  reviewed mainnet execution lane remain future gates.
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

### Reviewed hosted activation checklist

The checked-in route is runnable only after each category below is reviewed in
order. Checking in this list does not authorize an operator to perform any of
the actions.

**Non-secret deployment configuration**

1. Pin the reviewed application commit and keep `MAINNET_EXECUTION=false`.
2. Configure the canonical Pilot origin and Harbor URL. Configure the exact
   native route profile as `near-native-to-arbitrum-usdc-v1`; do not add a
   caller-selectable provider or RPC origin.
3. Keep the NEAR and Arbitrum RPC origins at the two code-pinned mainnet
   origins unless a separate code review changes the allowlist.
4. Select one immutable tenant, approval-gateway principal, policy digest, and
   native-NEAR atomic budget. Wallet changes must not create a new budget
   bucket.
5. Review the browser CSP against the exact commit-pinned Near Connect executor
   and sandbox behavior. Do not use a wildcard source. Verify the executor
   fetch, sandbox iframe, popup lifecycle, and callback origin in a disposable
   browser session before enabling the browser gate. The adapter reuses one
   bounded nonce already attached to the document's Next.js scripts and passes
   it to Near Connect; an absent nonce remains absent, while malformed or
   conflicting nonce values fail closed. This pass-through does not create a
   nonce or configure CSP. A deployment that later adopts nonce-only CSP must
   issue the matching nonce on its own scripts and complete browser acceptance;
   that conditional policy is not evidence that the current deployment uses
   nonce-based CSP.
6. Only after the server configuration is ready, enable the independent web
   gates `PILOT_NEAR_BROWSER_WALLET_ADAPTER_ENABLED`,
   `PILOT_NEAR_PRINCIPAL_BOOTSTRAP_ENABLED`,
   `PILOT_NEAR_INTENTS_EXECUTABLE_REVIEW_ENABLED`, and
   `PILOT_NEAR_OWNER_FUNDED_APPROVAL_ENABLED` together. Separately enable the
   Harbor review, provider-post, status, reserve, and reconcile gates. A public
   flag never substitutes for a Harbor authorization check.

**Credential, access, and state changes**

1. Review D1 backup/rollback and apply canonical migrations `0018`, `0019`,
   and `0020` in order. Confirm migration parity, tenant isolation, CAS
   contention, retention, and remote replay behavior before enabling traffic.
2. Provision distinct least-privilege Pilot-to-Harbor operation and hosted-state
   principals. Set `HARBOR_API_KEY`, `PILOT_HOSTED_STATE_API_KEY`, the matching
   `HARBOR_API_KEYS` entries, and any required D1/KEK bindings through the
   deployment secret store, never browser configuration.
3. Set a fresh high-entropy `SESSION_SECRET`, the exact NEP-413 recipient, and
   `PILOT_NEAR_WALLET_PROOF_MODE=verify`. Rotating the session secret invalidates
   existing authorizations and must be handled as an explicit rollout.
4. Add the server-only 1Click partner credential. Confirm provider and RPC
   egress policy, timeouts, body limits, redirect denial, and secret redaction.
5. Exercise read-only health, token-catalog, dry-quote, and remote-state probes
   before permitting an executable quote. Do not silently fall back to fixture
   data when any dependency is unavailable.

**Owner and financial acceptance**

1. With a disposable mainnet NEAR account and no funding action, verify the
   pinned executor, MyNearWallet popup/callback/close lifecycle, NEP-413 payload
   encoding, account/key ownership, cancellation, and replay denial. This step
   requires an owner wallet signature even though it moves no funds; fixtures
   cannot prove it.
2. Under separate authorization, request one fresh executable quote and review
   every economic and routing field. The earlier dry quote cannot authorize it.
3. Create the distinct economic approval and durable reservation, then verify
   cross-principal, wallet-change, expiry, idempotency-conflict, and concurrent
   budget denial against the hosted store.
4. A funded acceptance requires another explicit owner decision. The owner
   manually sends the exact native-NEAR amount to the exact quoted deposit
   account without a memo. Pilot never signs or broadcasts this transfer.
5. Verify finalized source evidence, signed provider status, and independent
   canonical-USDC delivery evidence. Provider `SUCCESS` alone is not final
   evidence. Provider `REFUNDED` remains held and cannot release budget until
   refund discovery and independent NEAR refund receipt verification are
   implemented and accepted.

The fixture browser lane can prove default-off rendering, responsive layout,
absence of wallet/provider calls, and fail-closed controls. It cannot validate
the real executor fetch, wallet popup, signature encoding, deployed CSP, route
liquidity, or settlement.

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
findings with scoped overrides. Five additional high advisories were inherited
from baseline `cb4f28e`: three in Undici 5.29.0
(`GHSA-vrm6-8vpv-qv8q`, `GHSA-v9p9-hfj2-hcw8`,
`GHSA-vxpw-j846-p89q`), one in its Busboy 2.1.1 dependency
(`GHSA-x8mw-p69m-v3mx`), and one in Zod 3.25.76
(`GHSA-mrhx-c7xc-m3w5`). This branch now pins only the two affected
`@ai-sdk/provider-utils` 3.x lines to Undici 6.29.1 and migrates the web,
contracts, and Harbor client schemas to Zod 4.6.7. The resolved production
graph contains one Undici version, one Zod version, and no Busboy dependency.

The compatibility gate exercises connect-time DNS pinning, private-address
denial, redirect revalidation, abort propagation, streaming, and bounded
downloads. The production web build also fails unless the `/api/chat` output
trace contains runtime files for and resolves exactly Undici 6.29.1. The
fixture-backed Zod migration preserves keyed-record behavior and passes the
contracts, Harbor client, web, agent, and full workspace suites. A fresh
`pnpm audit --prod --audit-level=high` reports zero high or critical findings;
11 lower-severity findings remain for separate review. These dependency checks
do not close the provider, wallet, migration, or funded-settlement acceptance
gates above, so this branch is still not a production deployment
recommendation.
