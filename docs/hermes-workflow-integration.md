# Hermes workflow advisory integration

Status: **complete default-off server integration; runtime activation remains an explicit operator action**.

The optional Hermes path reviews an already-selected, deterministic Pilot workflow lesson. It may return a bounded explanation and caveats. It cannot select or promote the lesson, alter policy, call Harbor, access a wallet, sign, submit, trade, or replace Pilot's existing model path. Any failure leaves the ordinary Pilot response and transaction boundaries unchanged.

## Implemented request path

1. The authenticated chat handler derives tenant, XRPL owner, and non-mainnet network scope on the server.
2. Pilot requires the current durable consent epoch plus an exact signed cookie for that scope and the disclosed provider/model/data policy/retention/terms.
3. A started retention sweeper runs a bounded due-session cycle. A stopped or unhealthy sweeper disables the advisory.
4. Pilot verifies private pinned profile files, the exact Hermes v0.22.2 runtime invariants, and a launcher-owned operational immutability proof for the running dedicated profile.
5. Pilot verifies signed bridge readiness and the live Hermes `/v1/toolsets` response. Every reported toolset must be disabled.
6. The adapter creates a fresh explicit Hermes session, durably registers its deletion and creation-settlement deadlines, and obtains a single-use bridge lease bound to the exact redacted user content, normalized Pilot message digest, server scope, profile, provider, model, and session.
7. Hermes may make one request to the fixed bridge. The bridge discards Hermes-added system and assistant messages, reconstructs the provider payload from Pilot's fixed system instruction plus the exact leased user content, verifies its digest, and durably reserves the conservative cost ceiling before contacting the fixed HTTPS provider. Timeout, cancellation, crash, or ambiguous outcome permanently spends the lease.
8. Pilot requires the exact session ID echo, validates the bounded read-only response and usage, then rechecks consent, profile files, operational proof, sweeper health, and bridge readiness. A concurrent revoke discards the advisory.

The chat route contains the real factory injection, but importing it neither starts services nor enables Hermes. The launcher must explicitly start and retain the bridge listeners and retention sweeper, establish the operational profile proof, and install those process-local activation services. Without all of them, both the chat factory and consent readiness fail closed.

## Exact data contract

The only proposal context sent through Hermes is:

- the fixed lesson category and value;
- an aggregate evidence count; and
- a fixed redaction flag.

Pilot does not include wallet addresses, tenant IDs, chat text, evidence references, transaction hashes, positions, trading policy, Harbor credentials, signing material, or model credentials. Hermes may add its own internal prompt while processing the turn, but that prompt is never forwarded by the bridge to the external provider. The provider receives only Pilot's fixed system instruction and the exact leased user content.

Hermes and the selected provider can persist the request or session. The consent UI names the provider and model and states that persistence explicitly. This path has network/model side effects when activated; only Pilot/Harbor/ledger mutation is prohibited.

## Consent and retention

Consent is a Secure, HttpOnly, SameSite=Strict cookie cryptographically bound to the authenticated tenant, owner, test network, exact disclosure, and durable epoch. Revocation advances the epoch before expiring the browser cookie, so a captured old cookie cannot be replayed.

Every fresh Hermes session is written to an owner-private atomic journal before the chat POST. A bounded creation fence prevents a crash-left or lock-contended session from remaining permanently undeletable without allowing a live request to be deleted early. Journal mutations use a durable owner record containing an exact PID, unique owner ID, and creation time. A crash-left lock is reclaimed only after 120 seconds, only when its regular owner-private single-link inode and identity are revalidated immediately before removal, and only when the recorded PID is definitively dead on this host. Live, permission-denied/ambiguous, malformed, replaced, or otherwise unsafe locks remain fail-closed and keep the retention sweeper unready. Revocation marks all non-deleted sessions pending immediately. The import-inert sweeper must be explicitly started and provides serialized, bounded, cancellable cleanup with retry limits. It sends authenticated `DELETE /api/sessions/{id}` followed by `GET`; only the exact `404 session_not_found` result records database-row absence. The UI does not claim that transcript files, compression ancestors, provider logs, or other history artifacts were erased.

## Pinned profile contract

The private manifest must pin Hermes `v0.22.2` at commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`, the profile/config hashes, disclosure, and the exact runtime invariants shared with the bridge:

- direct model requests on, one turn, one API attempt, zero recovery cycles;
- no fallback models, compression, title generation/upgrades, background review, memory, profile access, external providers, MCP, plugins, relay, context engine, native toolsets, or stored model override;
- zero tools, omitted temperature, and a fresh session for every request.

Private path verification rejects symlinks, hardlinks, noncanonical paths, foreign ownership, group/world access, granting macOS ACLs, replacement during a request, unknown manifest fields, and any invariant drift. Linux cannot provide the required native macOS ACL proof and fails closed in production; portable injected ACLs are used only by structural tests.

The manifest and signed bridge status are configuration evidence, not proof of the running Hermes process. Activation additionally requires a launcher-owned `assertImmutableProfile` implementation tied to the dedicated process. The consent endpoint reports `operational-gate-unavailable` until that proof is installed. A self-declared environment flag or manifest is not an acceptable substitute.

## Bounded bridge contract

The bridge has distinct fixed loopback control and ingress origins and credentials. It enforces exact method/path/Host/origin, loopback peers, request/response sizes, no redirect, no explicit provider, no tools, no streaming, no unknown request fields, the fixed provider/model/token-cap field, token prices, per-call cap, and durable per-scope daily spend cap.

Its atomic owner-private journal records `armed → attempting → completed|uncertain`; a provider call cannot begin until `attempting`, the attempt timestamp, normalized message digest, and conservative reservation are durable. Daily caps are charged to the UTC day of provider attempt, not lease issuance. On restart, a crash-left attempt becomes permanently uncertain. Session and lease tombstones are retained until the bounded journal reaches capacity and then the bridge fails closed pending separately reviewed rotation.

Signed bridge readiness proves only the bridge's current fixed configuration and exclusive listener ownership. Pilot independently checks the Hermes profile, live toolsets, operational immutability, and retention sweeper.

## Server-only configuration placeholders

Values must be provisioned outside the repository. Browser-visible variables are not used.

```dotenv
PILOT_HERMES_ENABLED=0
PILOT_HERMES_PROVIDER=<disclosed-provider-id>
PILOT_HERMES_MODEL=<fixed-read-only-model-id>
PILOT_HERMES_RETENTION_DAYS=<1-through-30>
PILOT_HERMES_TERMS_VERSION=<reviewed-version>
PILOT_HERMES_CONSENT_SECRET=<separate-secret-at-least-32-chars>
PILOT_HERMES_DAILY_CALL_LIMIT=<1-through-20>
PILOT_HERMES_RETENTION_STATE_PATH=<absolute-owner-private-json-path>

PILOT_HERMES_PROFILE=<dedicated-named-profile>
PILOT_HERMES_ORIGIN=<fixed-loopback-Hermes-origin>
PILOT_HERMES_API_KEY=<dedicated-profile-key>
PILOT_HERMES_PRIVATE_ROOT=<absolute-owner-private-root>
PILOT_HERMES_MANIFEST_PATH=<absolute-private-manifest>
PILOT_HERMES_MANIFEST_SHA256=<reviewed-sha256>
PILOT_HERMES_PROFILE_CONFIG_PATH=<absolute-private-profile-config>
PILOT_HERMES_ACL_HELPER_PATH=<absolute-reviewed-helper-path-on-macOS>
PILOT_HERMES_EGRESS_ORIGIN=<fixed-loopback-bridge-ingress-origin>
PILOT_HERMES_PROFILE_PROVIDER=<fixed-custom-provider-id>
PILOT_HERMES_PROFILE_MODEL=<opaque-lease-model-contract>

PILOT_HERMES_BRIDGE_CONTROL_ORIGIN=<distinct-loopback-control-origin>
PILOT_HERMES_BRIDGE_CONTROL_BEARER=<control-only-key>
PILOT_HERMES_BRIDGE_CONTROL_RESPONSE_KEY=<response-HMAC-key>
PILOT_HERMES_PROFILE_INVARIANTS_SHA256=<reviewed-contract-digest>
PILOT_HERMES_BRIDGE_CONFIG_SHA256=<reviewed-bridge-config-digest>
```

The separately owned bridge launcher also needs fixed ingress credentials, provider URL/credential, output-token parameter and cap, byte/time limits, reviewed integer token prices, per-call/daily micro-USD caps, and an owner-private journal path. Those provider secrets never enter Pilot or Hermes.

## Activation and verification boundary

Before activation, an operator must approve the provider/model/data recipient, price source, per-call/daily caps, retention period, profile and bridge credentials, fixed ports, and the dedicated-process immutability mechanism. The launcher must start the bridge and sweeper, verify both ready, install the process-local activation services, and stop/uninstall them on shutdown. No automatic startup occurs in application imports.

Offline tests cover the actual production factory, consent/revocation, strict manifest, live-toolset envelope, exact lease/session binding, bridge listener lifecycle, cancellation, spend journal, and cleanup sweeper with synthetic data and credentials. A prior pinned Hermes compatibility check established the v0.22.2 API envelope. This change did **not** send user data, call a real provider, incur model cost, activate runtime Pilot, access wallets, mutate Harbor, or touch a ledger. Synthetic coverage is not real-provider acceptance; one separately approved bounded synthetic provider call is still required before enabling real user traffic.
