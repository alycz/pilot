# Ledger trust flows

This change adds fail-closed building blocks for using Ledger as an owner trust
boundary. It does not replace or weaken the existing dedicated-payer x402
flow. Live execution, physical-device acceptance, production capability
credentials, and deployment remain disabled and unrun.

## Owner-reviewed native-XRP x402

The separate owner-review engine performs one fixed sequence:

1. Claim an idempotency key for the fixed local comparison resource.
2. Fetch and strictly validate one `402 Payment Required` challenge.
3. Accept only Testnet, native XRP, the fixed merchant account, the exact 5,000
   drop price, the reviewed source tag, a fee of at most 100 drops, and a
   bounded quote/ledger window.
4. Build an unsigned `Payment` from the connected owner account and return its
   exact approval digest and transaction.
5. Have the wallet sign only. Pilot's review binding shows the merchant,
   `0.005 XRP`, Testnet, and the maximum fee. Unsupported or blind-sign shapes
   have no fallback.
6. Before any relay, decode the signed blob and verify the owner account,
   public key, cryptographic signature, transaction hash, and every unsigned
   field against the reviewed `Payment`.
7. Allow one relay winner. A timeout or lost response becomes
   `settlement_unknown`; it is reconciled by hash and is never automatically
   paid again.
8. Require exact settlement evidence before fetching the resource again with
   the same signed payload and returning a bounded merchant response. The
   mounted route labels its deterministic result
   `local-mock-simulated-settlement`; it is not ledger validation evidence.

The owner-review records use a D1 compare-and-swap store with atomic
idempotency claims and revision/status transitions. Four authenticated Harbor
operations expose prepare, reject, submit, and read-only recovery in exact
local mock mode. The browser proxy binds those operations to the wallet session,
and `/demo/ledger-x402` mounts the device review flow. Merchant, ledger, relay,
settlement, and resource adapters remain deterministic local simulations.
Issued-asset settlement and RLUSD x402 are not yet reachable or claimed.

An additive issued-asset signing binder defines the future boundary without
changing this native-XRP flow. It accepts only the official Testnet CAIP-2
identifier `xrpl:1` together with Pilot's `testnet` execution network, a
40-hex currency, classic issuer and payee, positive canonical decimal amount,
and an unsigned direct `Payment`. `Amount` and `SendMax` must be identical,
which permits no unreviewed transfer-fee or slippage headroom. Fee, sequence,
ledger window, source tag, invoice, quote lifetime, connected account, and all
transaction fields are exact-bound before signing and reverified from the
signed blob. The current support profile is pinned to XRP app `2.8.2`; unknown
app versions and blind-sign shapes are rejected. This is a pure offline binder,
not Harbor adapter, browser route, settlement, or physical-device evidence.

## Exact Ledger actions

`@pilot/wallet` now has one exact-action policy for:

- native-XRP `Payment`;
- `DelegateSet` grant and revoke;
- `EscrowCreate`, `EscrowFinish`, and `EscrowCancel`.

The policy binds the account, test network, sequence, validated-ledger window,
fee cap, amount, destination, invoice, tags, permissions, escrow identifiers,
conditions, and time bounds. Unknown fields and unsupported transaction types
are rejected. `DelegateSet` remains explicitly labelled blind signing; no other
blind transaction is accepted by this policy.

Runtime provenance is recorded as `ledger-webhid` or `speculos`. A valid
signature proves control of the account key. It does not prove that the signer
was a physical Ledger, and Speculos is always described as simulation using its
public default test seed.

## Scoped capability broker

The broker hands the agent only an opaque `cap_v1_…` reference. A grant binds
one principal and account to one configured service/operation, amount and unit,
destination identifier, validity interval, use count, rate limit, and
generation. A server-side resolver lends a secret only to a fixed adapter
callback; neither the secret nor its internal handle appears in broker output
or audit events.

Invocation has `reserve → dispatch → completed | unknown` semantics. Exact
request replay returns the prior result, conflicting replay is rejected, and an
ambiguous dispatched call consumes its use without automatic retry. Revocation
increments the generation and fences work that has not reached its adapter.
Escalation requires preparing a new exact grant; there is no widening method.
Arbitrary URLs, methods, headers, credentials, redirects, and proxy controls
are not part of the interface and are rejected when smuggled into input.

This broker is default-off and mock-secret-store-only. Six local-only Harbor
operations prepare, activate, invoke, inspect, prepare revocation, and revoke a
grant. Activation and revocation reconstruct a non-broadcast, zero-fee
`AccountSet` proof and verify its exact memo fields, account, public key, and
signature. A signed blob proves owner-key control only; it cannot authenticate
WebHID, Speculos, or a physical device. Ledger does not store or encrypt service
secrets. No production credential creation is implemented.

Local capability state uses a per-principal D1 lease and generation-fenced
snapshot replacement. A second durable checkpoint refreshes that fence after
secret resolution and immediately before dispatch. Resolver and adapter
deadlines remain below the lease; an adapter timeout becomes durable `unknown`
and never redispatches. State fails closed at 32 grants or 16 retained receipts
without deleting replay or revocation tombstones. The fixed adapter can read
only one of two fixture resources. It cannot accept a URL, method, header,
redirect, credential, or arbitrary amount. Capability operations are omitted
from the production Harbor registry even if a caller knows their names.

`/demo/ledger-capabilities` mounts the complete local mock lifecycle without
changing shared navigation: prepare an inactive grant, reconstruct and
exact-compare the proof-only `AccountSet` memo, sign and activate, inspect
scope/quota/expiry, invoke the fixed fixture, replay only the same request id,
and sign revocation before confirming a fresh invocation is denied. Public
recovery storage is account-namespaced and contains only an opaque reference or
an exact invocation tuple; it never stores a signed blob, proof, or secret. An
ambiguous prepare is locked because the current Harbor API has no safe lookup
for a committed-but-lost capability reference.

## Escrow-backed work agreement

The work-agreement state engine binds immutable owner, counterparty, network,
native-XRP amount, condition, and time bounds. Create, release, and cancel each
require an exact forced-owner approval request. It cryptographically verifies
the signed blob before deriving the expected transaction hash, and accepts
settlement evidence only after the preparation ledger and no later than the
reviewed `LastLedgerSequence`. The escrow offer sequence is derived only from
validated create evidence. Release and cancel are mutually exclusive.

An ambiguous submission freezes replacement until exact validated evidence or
a complete post-expiry non-inclusion proof is supplied. The local runtime now
stores immutable D1 revisions and replay tombstones, claims a submission once
with CAS, and reconciles after restart through lookup only. A durable mock-relay
record retains the signed public transaction solely so the no-network fixture
can reproduce an external lookup after restart; the agreement journal itself
never stores the signed blob. The fixed same-origin browser client persists
only bounded account/approval/idempotency/attempt recovery references.

The runtime is explicitly `local-testnet-mock-v1`, reports
`local-mock-simulated-settlement`, makes no network request, and claims neither
live ledger validation nor physical-Ledger/Speculos provenance. `/agreements`
still mounts the older deterministic fixture presentation whose recorded blobs
are invalid and never cross the cryptographic boundary. Mounting the new
durable controller in the PR13-owned presentation remains a separate UI step.

## Issued-payment approval commitment

The issued-asset signing seam uses the versioned domain
`pilot.x402.owner-approval` and a strict JCS-compatible canonical JSON subset.
Its SHA-256 digest covers the approval ID, Testnet/`xrpl:1`, authenticated
session scope, idempotency key, merchant identity and exact `POST` resource,
payee, exact issued asset/currency/issuer/value, owner, raw merchant invoice,
quote expiry, fee, sequence, preparation-ledger basis, last-ledger bound, and
source tag. The digest is uppercase hex and must equal both
`approval_digest` and the unsigned and signed Payment `InvoiceID`.

This makes the Ledger signature authenticate the semantic commitment through
`InvoiceID`; changing the service, session, operation, asset, amount, party,
expiry, or transaction bounds changes the signed transaction. The challenged
raw merchant invoice remains a separate uniqueness/replay fence. No memo is
used because its clear-sign display support has not been proven for the pinned
XRP app profile. This is an issued-asset-only atomic wire migration: existing
native-XRP and AP4M invoice-hash contracts are unchanged and must never be
mixed with this profile.

Harbor's issued adapter and deterministic fixture transport implement this
profile, but the older Python merchant fixture does not. Its parser still
expects `InvoiceID = SHA256(raw merchant invoice)` and its
`PAYMENT-SIGNATURE` payload does not carry the semantic envelope. Consequently
Harbor-to-Python-merchant compatibility is intentionally blocked until that
parser and payload migrate atomically; no dual or fallback acceptance is safe.

## Reachable local paths

All new reachable paths are disabled by default:

- `x402.ownerReviewPrepare`, `x402.ownerReviewReject`,
  `x402.ownerReviewSubmit`, and `x402.ownerReviewRecover` require an
  authenticated exact local Testnet Harbor, mock mode, mainnet disabled, and
  the dedicated owner-review enable flag.
- The browser route accepts only those four fixed operation names, same-origin
  requests, the authenticated Testnet wallet account, and the fixed merchant,
  native-XRP amount, and network schema.
- `capability.prepare`, `capability.activate`, `capability.invoke`,
  `capability.status`, `capability.prepareRevoke`, and `capability.revoke` are
  local-registry-only and additionally require named Bearer authentication, the
  dedicated local capability flag, mock mode, Testnet, mainnet disabled, and
  D1. Their signed owner review and grant digest include the literal network.
- The browser proxy accepts exactly those six fixed capability operations only
  in local-wallet mock mode. Every operation is bound to the authenticated
  wallet account and Testnet session; activation and revocation additionally
  require an `AccountSet` signature from that same account.
- `workAgreement.prepare`, `workAgreement.submit`, `workAgreement.recover`,
  `workAgreement.reject`, and `workAgreement.status` require named Bearer
  authentication, the dedicated work-agreement flag, local mock mode, Testnet,
  mainnet disabled, D1, and an explicit source tag. The browser proxy binds all
  five operations to the wallet session; submit additionally requires a valid
  signed EscrowCreate/EscrowFinish/EscrowCancel from that account.
- `/api/agreements/fixture` returns `404` unless the non-production fixture flag
  is set. It accepts bounded same-origin JSON only and has no external adapter.

## Capability matrix

| Capability | Implemented | Simulation or mock | Still missing |
| --- | --- | --- | --- |
| DMK sign-only wallet | Existing account/field/signature checks; exact-action policy added | Speculos is explicitly simulated | Physical-device acceptance is unrun |
| Owner-reviewed x402 | Challenge validation, exact native-XRP owner payment, D1 CAS, wallet-bound browser route, mounted review UI, one-shot relay, settlement recovery, bounded receipt | Local merchant/ledger/relay/settlement/resource adapters | Live adapters and any live Testnet check |
| Sensitive funds | Exact owner `Payment` review and mounted sign-only flow | Local mock settlement only | Physical-device acceptance and live Testnet validation |
| Permission grant/revoke | Exact `DelegateSet` permission tuple with explicit blind-sign review | Offline and existing public-seed fixtures | New-flow Speculos conformance and physical-device acceptance |
| Scoped API capability | Opaque account/network-bound scope, resolver seam, quotas, expiry, replay/rate/revocation/redaction, exact signed activation/revocation, named-auth Harbor routes, wallet-bound browser proxy, mounted lifecycle UI, reload-safe exact invocation recovery, pre-dispatch lease fence, bounded D1 snapshots | Mock secret store and fixed mock adapter | Production secret store/adapters and device-authenticated transport provenance |
| Escrow work agreement | Exact create/release/cancel review, real signature verification, named-auth and wallet-bound routes, immutable D1 CAS/replay history, one-shot mock relay, restart recovery, fixed same-origin client | Local Testnet mock settlement only; `/agreements` remains the visibly invalid recorded-fixture UI | Mount durable controller after PR13; escrow Speculos, physical-device, live adapter and live Testnet conformance |
| Issued-asset/RLUSD x402 | Strict Testnet request schema, versioned service/session/idempotency approval commitment in signed `InvoiceID`, exact issued-asset Payment binder, pinned XRP-app display profile, signed-blob verification | Harbor deterministic fixture transport only | Atomic Python merchant envelope/payload migration, browser route/UI, settlement, app-config plumbing, and device conformance |
| Streaming/payment channels | Existing generic primitives only | None in this change | Device-approved setup/fund/close and bounded claim delegation |

## Verification lanes

Offline tests cover changed fields, wrong accounts/networks, stale quotes,
expiry, rejection, timeouts, replay, double click, revocation races, use/rate
limits, secret redaction, ambiguous outcomes, exact settlement evidence, D1
lease recovery/serialization, mounted browser requests, and escrow terminal
exclusivity. Offline wallet conformance covers clear-sign classification and
binary round trips for native Payment and escrow actions. Actual Speculos and
physical-device execution, live Testnet checks, and deployments remain
explicitly unrun.

See `docs/ledger-trust-operator-handoff.md` for the default-off configuration,
local verification, approval gates, cost boundaries, and remaining code.
