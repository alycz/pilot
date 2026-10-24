# Native XRPL issued-currency x402 adapter

## Status and evidence boundary

This branch implements a local, default-off x402 v2 `exact` pipeline for an
XRPL trust-line token whose identity is the exact tuple `(network, currency,
issuer)`. It is intended for RLUSD-shaped native XRPL payments. It is not the
XRPL EVM sidechain ERC-20 representation of RLUSD.

The completed lane is offline only:

- a payer signs a real XRPL `Payment` transaction in the test process;
- the adapter decodes the binary transaction and verifies its signature;
- verification uses one deterministic ledger snapshot containing AccountRoot
  and RippleState-shaped records;
- settlement and reconciliation use a persistent, hash-keyed local ledger
  emulator with an active `(network, payer, sequence)` lock, without submitting
  to a facilitator or ledger; and
- resource responses and persisted receipts label the evidence
  `deterministic-offline-fixture`.

No faucet, account creation, trust-line mutation, payment, deployment, or live
facilitator call was run. A fixture response is not a validated transaction
receipt.

## Wire contract

The existing XRP path is unchanged. Its challenge still uses `asset: "XRP"`
and an integer drops string.

The additive issued-currency path uses:

- `scheme: "exact"`;
- `network: "xrpl:1"` exactly;
- an uppercase 40-hex currency code;
- a separately allowlisted classic issuer address in `extra.issuer`;
- a positive canonical decimal-string amount with at most 15 significant
  digits, never a JavaScript or Python float;
- `extra.areFeesSponsored: false`;
- `extra.assetTransferMethod: "sequence"`; and
- the existing source-tag and SHA-256 InvoiceID bindings.

This is explicitly a Pilot native-XRPL-issued-currency extension carried in an
x402 v2 `exact` envelope, not a universally supported x402 asset profile.
Pilot's stricter resource echo, issuer, and source-tag bindings are local
controls. A future live lane must verify the selected facilitator's supported
network, issued-asset behavior, and exact payload shape before enabling it.

## Fail-closed policy

The initial local profile accepts holder-to-holder transfers only. It rejects:

- a network, currency or issuer outside the exact allowlist;
- issuer-as-payer, issuer-as-payee, or payer-as-payee special cases;
- noncanonical, nonpositive, exponent, overprecision, or float amounts;
- missing or ambiguous payer/payee trust lines;
- insufficient issued balance or destination trust-line headroom;
- issuer Global Freeze or Require Auth;
- any trust-line freeze or deep freeze;
- non-default issuer transfer fees;
- missing Default Ripple, stale account sequence, insufficient XRP fee balance,
  or violation of the separate XRP reserve floor;
- cross-issue or non-exact `SendMax`, `Paths`, `DeliverMin`, partial-payment
  flags, Memos, Delegate, unknown fields, or invalid signatures; and
- a validated result whose `delivered_amount` is missing, `unavailable`, a
  native drops string, or a different issued identity/value.

Transfer-fee and Require-Auth assets are intentionally unsupported rather than
silently approximated. The official scheme can model transfer fees with a
larger same-issue `SendMax`, but enabling that requires a separate trusted
overhead policy and additional issuer-state review.

## Budget and retry behavior

The issued budget ledger is disabled unless explicitly constructed as enabled.
It atomically reserves per-call, daily, and lifetime issued amounts by the full
asset identity. XRP fee caps and the minimum XRP reserve use integer drops in a
separate accounting dimension; no model-supplied or market price converts an
issued amount into a fee or reserve.

Invoice and idempotency bindings are unique. Concurrent reservations cannot
oversubscribe a cap or the aggregate fee/reserve floor. A same-binding replay
reuses the reservation. Once
settlement is uncertain, the reservation remains counted and retry performs
reconciliation instead of signing or settling a second payment. It is released
only after the complete ledger window proves non-inclusion, with retry repairing
an interrupted release, or committed after validated reconciliation.
The same proof releases the local sequence lock while retaining the old
hash-keyed result for deterministic replay evidence.
An atomic sequence-lock race loser is recorded as a definite pre-submission
rejection; its budget is released and exact replay returns the cached rejection.

## Future live operator inputs

A live lane remains off until a later coordinated change supplies all of the
following through reviewed server-side configuration:

1. exact network, 40-hex currency, issuer, merchant address, and asset allowlist;
2. asset per-call/daily/lifetime caps plus independent XRP fee and reserve caps;
3. a facilitator whose advertised and observed behavior supports this exact
   native issued-currency contract;
4. one-network routing, ledger-state/simulation evidence, signature verification,
   shared settlement deduplication, and reliable-submission reconciliation; and
5. an explicit custody selection. The current Harbor payer remains separate
   from any Ledger owner-sign flow and is not replaced by this adapter.

The typed seams live in `apps/web/api/x402/assets.py`, `budget.py`,
`issued_ledger.py`, and `issued_compare.py`. They do not change the shared
Pilot/Harbor contract hash copies or the Ledger-owned approval/UI/state files.

## Harbor offline integration seam

`services/harbor/src/exec/x402-issued-offline.ts` is the matching default-off
TypeScript route seam. It is deliberately separate from Harbor's existing XRP
engine and exposes an in-process `Request` handler rather than mounting a live
server route. Its deterministic test drives the complete local sequence:

1. parse the Python merchant extension's issued challenge shape;
2. enforce the exact asset allowlist and per-call/daily/lifetime decimal caps,
   plus separate per-call/daily/lifetime XRP fee and reserve caps;
   validate issuer flags/transfer rate, both trust lines, issued balance and
   destination capacity, and the ledger-derived XRP reserve;
3. construct an issued `Payment` with exact `Amount` and same-issue/equal-value
   `SendMax`, SHA-256 InvoiceID, sequence, fee, and timeout-derived ledger bound;
4. present the exact strict request consumed by the Ledger issued-payment
   binder: approval id/digest, owner, Testnet/asset identity, quote expiry,
   ledger window, fee/tag/invoice, and an unsigned ten-field `Payment`;
5. cryptographically inspect the returned signed blob before forwarding it;
6. bind the returned `PAYMENT-RESPONSE` to the signed hash, payer, network, and
   explicit deterministic-fixture provenance; and
7. cache exact concurrent/idempotent replay without a second sign or send.

The result status is `fixture_delivered`, not `delivered`, because the merchant
response is not independent validated-ledger evidence. A failed or malformed
post-send response retains an uncertain budget reservation and requires a later
reconciliation implementation; it never signs again. Pre-sign failure releases
the local reservation. Merchant, preflight, owner-signing, and receipt reads
have bounded deadlines, and the unmounted request seam rejects bodies above
4 KiB before execution. Approval identifiers/digests, invoice IDs, and payer
sequences are independently replay-fenced.

The coordinated issued-only Ledger binder and Harbor now share approval
envelope v1. Both recursively canonicalize the strict integer/string-only
envelope, SHA-256 the UTF-8 JSON, and require the uppercase digest to equal both
`approval_digest` and the unsigned/signed Payment `InvoiceID`. The envelope
binds resource, merchant, session, idempotency key, asset, amount, owner/payee,
expiry, fee, sequence, ledger window, validated-ledger basis, and source tag.
The raw merchant invoice remains separately protocol-visible and uniqueness-
fenced; the older `InvoiceID = SHA256(raw merchant invoice)` convention is not
accepted as a fallback.

The TypeScript Harbor/Ledger seam implements that migration. The earlier Python
merchant fixture still validates the historical raw-invoice hash and does not
yet receive the semantic envelope in `PAYMENT-SIGNATURE`; cross-process
Harbor-to-Python compatibility therefore remains disabled until that parser and
its fixtures migrate atomically. Mixed acceptance must never be enabled.

The route requires separate state and budget authorities. In-memory authorities
remain available for deterministic tests. The issued-only D1 authority adds
durable state, exact decimal/fee budgeting, uniqueness constraints, and a
fail-closed payer mutex. The reconciliation adapter independently validates
exact transaction and delivered-amount evidence, and releases only after a
complete bounded post-expiry non-inclusion proof. Its checked-in reader is an
explicit offline fixture; a live reader remains absent.

The separately gated `x402.payIssuedFixture` Harbor/client operation can consume
this seam through an injected issued fixture service; existing `x402.pay` is
unchanged. No Agent tool or Ledger UI/state file is edited here. The owner-
signing workstream supplies the exact binder in
`packages/wallet/src/ledger/issued-payment.ts`; this branch does not edit it.
Harbor's current dedicated XRP payer remains unchanged and is not silently
replaced. The shared central contract/hash copies remain unchanged because the
issued fixture uses a separate additive operation contract and client binding.

## Operator handoff (not activation authorization)

Required accounts and public resources:

- one owner classic address whose Ledger device controls the enabled master key;
- one distinct merchant/payee classic address;
- exact Testnet RLUSD 40-hex currency and classic issuer allowlist entry;
- payer and payee trust lines at one validated ledger, with payer balance and
  destination capacity sufficient for the approved amount;
- issuer, payer and payee AccountRoot evidence, reserve base/increment, validated
  ledger index, payer sequence, and exact merchant URL; and
- a durable D1 state/budget implementation plus a reviewed local route binding.

Configuration placeholders, all absent/default-off until later coordination:

- `HARBOR_LOCAL_X402_ISSUED_RUNTIME_ENABLED=false`
- `HARBOR_LOCAL_X402_ISSUED_SIGNING_PROFILE=<reviewed-profile-id>`
- `HARBOR_LOCAL_X402_ISSUED_CURRENCY=<40-uppercase-hex>`
- `HARBOR_LOCAL_X402_ISSUED_ISSUER=<classic-address>`
- `HARBOR_LOCAL_X402_ISSUED_PAY_TO=<classic-address>`
- asset and XRP fee caps for per-call/daily/lifetime, minimum XRP reserve, and
  the reviewed source tag.

Secret values must be entered only through the project's reviewed encrypted
local capability/secret-file flow with owner-only permissions; never place them
in shell history, repository files, logs, screenshots, chat, or fixtures. This
work does not require or accept a seed/private key: Ledger signs after an owner
approval, and Harbor receives only the signed result.

Local verification is typecheck plus focused offline suites, the Python ASGI
fixture route, signer-request schema parity, and existing XRP regressions. Live
verification remains a separately authorized Testnet lane: provision reviewed
accounts/trust lines, query fresh validated state, approve on the Ledger device,
submit once, and independently reconcile validated `tesSUCCESS` plus exact
`delivered_amount`. No live verification was run here.

Costs requiring explicit approval include XRP account reserves, trust-line owner
reserve, network fees, issued RLUSD transfer value, facilitator/provider fees,
Cloudflare/D1 usage, RPC provider usage, hardware, deployment, and domains.
Creating accounts/resources, funding, trust-line changes, permission changes,
deployment, and credential activation are all outside this branch.
