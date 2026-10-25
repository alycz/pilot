# AP4M XRPL EVM event adapter

This adapter is an isolated, default-off implementation of the Mastercard AP4M
event payment rail on XRPL EVM Testnet. It does not replace or widen Harbor's
native XRPL AP4M, payment-channel, or x402 contracts.

## Fixed event profile

The implementation accepts only this code-owned profile:

| Field | Value |
| --- | --- |
| Chain | XRPL EVM Testnet (`1449000`) |
| JSON-RPC | `https://rpc.testnet.xrplevm.org` |
| Explorer | `https://explorer.testnet.xrplevm.org` |
| PaymentLedger | `0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91` |
| Pooled escrow vault | `0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0` |
| RLUSD token | `0x27b57a9D0b8d24EB97259c4E2279e45255e016f3` |
| RLUSD decimals | `18` |

Remote configuration and RPC responses are untrusted reference data. They may
confirm the fixed profile but cannot change it.

The values above were checked against the unauthenticated
[public event configuration](https://hackathon.ap4m.build/public/config). The
remote document is confirmation only: a changed remote value must stop the
rail and trigger a code review rather than silently changing a signing target.

Protocol references used for this independent implementation are the official
[AP4M integration guide](https://hackathon.ap4m.build/integration-guide) and
the public event configuration. The event's detailed API and x402 documents
returned `401` to unauthenticated requests. They were not accessed with a
participant login, inferred from a private response, or worked around. Any
behavior that depends on those documents remains unsupported until the exact
public or explicitly approved specification is reviewed.

## Capability and acceptance boundary

`AP4M_EVM_EVENT_ENABLED` defaults to `false`. The accepted baseline mode is
`mock`; it requires mock Harbor, rejects `LIVE=1`, and performs no external
effect. Code in this integration worktree may add injected HTTP/RPC transport,
reconciliation, and browser owner-wallet approval interfaces, but their
presence is not authorization to enable the rail. All automated tests use
mocked transports, RPC, and wallet providers with locally generated fixtures.
They are not live-Testnet acceptance evidence.

Live mode must continue to fail closed until a separate acceptance run verifies
the exact profile, service contract, browser approval path, receipt decoding,
settlement evidence, and configuration. No model tool may sign, open a channel,
or elevate authority. An operation registered for the rail must return an
approval-bound preparation or reconciliation result, never an implicit signing
or submission capability.

## Trust and custody rules

- Never accept an arbitrary RPC URL, explorer, chain, contract, token, calldata,
  typed-data domain, or merchant payout from the model.
- Merchant payout must be nonzero and different from both agent and funding
  wallets.
- Prepared transaction target, selector, arguments, sender, native value, gas
  cap, exact legacy gas price, chain, token, channel, and approved purpose are
  checked locally. EIP-1559 or mixed fee fields fail closed for this event
  profile.
- Voucher typed data uses name `AP4M Payment Ledger`, version `1`, chain
  `1449000`, and the fixed PaymentLedger verifying contract. Its channel and
  cumulative amount must match local durable state and never exceed the cap.
- Complete `VoucherRedeemed` events are decoded from the fixed PaymentLedger
  address. Address/topic-only matching is insufficient, and a transaction hash
  alone is not settlement proof.
- Success requires independently checked on-chain evidence that the expected
  RLUSD amount reached the exact bound merchant payout address. A service
  receipt, a redemption event, or a claimed payout hash without recipient and
  token-transfer evidence is insufficient.
- Unknown submission or reorganization state remains pending and is reconciled
  by transaction hash. It is never blindly resubmitted.
- Owner authorization uses an injected browser wallet/provider. Signing and
  submission are separate, explicit user actions bound to the reviewed chain,
  contract, calldata, merchant, payout, cap, fee/gas limit, expiry, and
  idempotency key. Approval expiry must be contained by the reviewed channel
  `validAfter`/`validBefore` window. Harbor never receives an owner private key
  or seed.
- Private keys, automatic sign-in, automatic channel creation, and automatic
  payment sequences are outside this adapter. Model output cannot trigger a
  wallet prompt or enlarge authority.
- Close-channel typed data is rejected until an official EIP-712 close schema
  is independently verified. No schema or compatibility shape is inferred from
  an event starter bundle or an unverified service response.

## Manual acceptance still required

Do not enable live mode merely because offline tests pass. A separately
authorized operator must complete all of the following on XRPL EVM Testnet:

1. Obtain or confirm the hackathon participant/team account and exact registered
   team name through the official event portal. No repository or deployment
   secret substitutes for that account permission.
2. Register the public address of the intended agent/owner EVM wallet, using a
   supported injected browser wallet. Never place its private key or seed in
   Harbor, Pilot, an environment variable, a log, or a fixture.
3. Register a merchant payout address that is nonzero and distinct from both
   the agent wallet and the funding wallet.
4. Fund only the event Testnet budget with test RLUSD through the approved
   portal flow, and fund the agent wallet with only Testnet XRP required for
   bounded gas. No mainnet asset or real funds are permitted.
5. Establish the official wallet-challenge/session flow and decide the bounded
   session-token custody and expiry policy. No long-lived participant token or
   provider credential is currently accepted as a repository setting.
6. Review and approve the exact runtime profile: chain `1449000`, PaymentLedger,
   pooled vault, RLUSD token and `18` decimals, canonical service origin, RPC,
   explorer, confirmation depth, maximum gas limit, maximum fee, channel cap,
   merchant identifier, and payout address.
7. With a human present, connect the browser wallet to chain `1449000`, inspect
   the decoded prepared call and EIP-712 voucher, and explicitly approve one
   bounded Testnet submission. Do not use an automatic channel-open or payment
   script for acceptance.
8. Reconcile an intentionally ambiguous submission by hash without resubmitting,
   then verify finality, the complete redemption event, and the RLUSD transfer
   amount/token/recipient at the merchant payout address.
9. Apply AP4M migration `0016` before the hosted-persistence owner's reserved
   `0017_hosted_pilot_state.sql`; confirm that deployment order together before
   rollout. Run all integrity, typecheck,
   offline, build, browser-fixture, contract-parity, and migration-inventory
   checks again before any deployment decision.
10. Only after the preceding evidence is reviewed may an operator set the
    live-enable configuration. The default and every unreviewed environment
    remain disabled; deployment and merge are separate decisions.

Genuine protocol blockers are the unavailable authenticated API/x402 details,
the absence of an independently reviewed close-channel typed-data schema, and
any settlement or receipt shape that cannot be tied to complete on-chain RLUSD
recipient evidence. These gaps must fail closed rather than be guessed.

## Migration and rollout

Migration `0016_ap4m_evm_event.sql` reserves isolated event-channel, attempt,
and journal state. It does not modify native XRPL or isolated x402 tables. The
native issued-RLUSD migration profile is maintained separately and must be
reconciled before any deployment plan allocates additional numbers.

This repository contains no copied event starter bundle or restricted AP4M SDK.
The implementation is written independently from the documented public
protocol shape. Harbor uses the pinned
[`viem`](https://github.com/wevm/viem) dependency for ABI and EIP-712 primitives;
its upstream license remains authoritative and the existing dependency notices
continue to apply. Live RPC calls, wallet signing, merchant enrollment, funding,
settlement, remote migrations, and deployment are separate acceptance actions,
not consequences of compiling this code.
