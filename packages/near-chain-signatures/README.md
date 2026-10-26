# `@pilot/near-chain-signatures`

This optional package is a narrow compatibility and safety boundary for preparing
a native XRP **Testnet** payment with the official `chainsig.js` XRP adapter,
binding the exact prepared payload to owner review, formatting the corresponding
NEAR **testnet** Chain Signatures function call, and applying the returned MPC
signature. It does not submit either the NEAR or XRP transaction.

## Supported boundary

- `chainsig.js` 1.1.16, reviewed at upstream commit
  `17aec4f932ec5ca49a4a52a167dbb31a2b77710e`;
- NEAR `testnet`, contract `v1.signer-prod.testnet`;
- XRP Testnet RPC `https://s.altnet.rippletest.net:51234`;
- native XRP `Payment` only, with an integer amount in drops;
- the source XRP address and public key derived by the official adapter from the
  NEAR account and network-separated path, never supplied by the caller;
- a caller-provided maximum XRP network fee, with fee, sequence, and last-ledger
  expiry included in the exact review binding;
- secp256k1 / `Ecdsa` / `domain_id: 0`;
- derivation paths beginning `pilot:xrp:testnet:v1:` so another network cannot
  silently reuse this key path; and
- one 32-byte payload and one RSV signature.

The official library owns XRP serialization, signing-hash construction, address
derivation in the integration, and DER signature formatting. Pilot does not
implement those cryptographic operations. The narrow `OfficialChainsigXrpPort`
intentionally omits the library's generic contract `sign` and XRP `broadcastTx`
methods.

Prepared and review-bound values are process-local capabilities. Copying or
deserializing them intentionally invalidates the capability, so an arbitrary
32-byte value cannot be wrapped in a forged object and passed to the request
formatter. If persistence across a process boundary is later required, it needs
a separately reviewed revalidation design; do not weaken this guard ad hoc.

`formatXrpSignatureRequest` returns a review-bound request for an owner-controlled
wallet. Its `gas` value (`300000000000000`) is NEAR function-call gas, not a
trade or payment budget. Its one yoctoNEAR deposit is the contract-call deposit,
not XRP funding. An integration must still obtain the owner's wallet signature;
the local approval reference is not cryptographic proof.

## Non-goals

This package has no mainnet configuration, generic arbitrary-message signing,
wallet connection, credential handling, funding, faucet, broadcast, retry, or
settlement logic. A successful NEAR transaction only means the signature request
completed. It does not prove XRP submission, validation, settlement, or any
external state. `classifyNearSignatureStatus` preserves those distinctions.

The current official XRP adapter's public request type includes optional fields
such as destination tags, memos, fees, and sequences, but its 1.1.16 preparation
implementation does not consistently forward those values into `autofill`.
This boundary therefore does not accept them rather than silently dropping a
reviewed field.

## Integration sketch

The dependency-heavy official adapter is an explicit opt-in subpath. Importing
the package root does not load `chainsig.js` or its multichain dependency tree:

```ts
import {
  createOfficialNearXrpTestnetAdapter,
} from "@pilot/near-chain-signatures/official";

const adapter = createOfficialNearXrpTestnetAdapter();
```

The `./official` subpath implements the trusted factory with the exact
`chainsig.js` 1.1.16 dependency and the package's pinned values. It deliberately
narrows the official adapter to the reviewed preparation/finalization methods
and does not expose generic signing or broadcast methods. Keep this subpath out
of runtime bundles until the separate Chain Signatures execution gate is
reviewed and enabled.

The dependency and factory wiring do not make this a live/testnet-accepted
signing path. Owner-wallet integration and external Testnet acceptance remain
separate gates.

## Evidence and references

- NEAR Chain Signatures overview:
  <https://docs.near.org/chain-abstraction/chain-signatures>
- NEAR transaction-signing flow and testnet deployment:
  <https://docs.near.org/chain-abstraction/chain-signatures/implementation>
- Official library source: <https://github.com/NearDeFi/chainsig.js>

Tests are mock-only and perform no RPC, wallet, signing, broadcast, or funding
operation.
