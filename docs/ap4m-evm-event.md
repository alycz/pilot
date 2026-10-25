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

Protocol references used for this independent implementation are the official
[AP4M integration guide](https://hackathon.ap4m.build/integration-guide) and
[public event configuration](https://hackathon.ap4m.build/public/config).

## Shipped capability

`AP4M_EVM_EVENT_ENABLED` defaults to `false`. The only implemented mode is
`mock`; it requires mock Harbor, rejects `LIVE=1`, and has no network, signer,
transaction-submission, scheduler, or fallback capability. It exposes only
code-owned validation and durable-state methods for prepared voucher redemption,
EIP-712 voucher values, role separation, monotonic cumulative amounts, exact
receipt logs, finality, idempotency, and ambiguous-submission recovery using
deterministic inputs. These methods do not perform an effect.

No Harbor operation or agent/model tool is registered by this slice. Adding an
operation, approval UI, or signer is a separate review boundary. Until then,
effectful requests fail with `RAIL_NOT_CONNECTED`.

## Trust and custody rules

- Never accept an arbitrary RPC URL, explorer, chain, contract, token, calldata,
  typed-data domain, or merchant payout from the model.
- Merchant payout must be nonzero and different from both agent and funding
  wallets.
- Prepared transaction target, selector, arguments, sender, native value, gas
  cap, chain, token, channel, and approved purpose are checked locally.
- Voucher typed data uses name `AP4M Payment Ledger`, version `1`, chain
  `1449000`, and the fixed PaymentLedger verifying contract. Its channel and
  cumulative amount must match local durable state and never exceed the cap.
- Complete redemption events are decoded from the fixed PaymentLedger address.
  Address/topic-only matching is insufficient.
- Unknown submission or reorganization state remains pending and is reconciled
  by transaction hash. It is never blindly resubmitted.
- Private keys, automatic sign-in, automatic payment sequences, and raw signed
  payloads are outside this adapter.
- Close-channel typed data is rejected until an official EIP-712 close schema
  is independently verified; no schema is inferred from an event starter bundle.

## Migration and rollout

Migration `0016_ap4m_evm_event.sql` reserves isolated event-channel, attempt,
and journal state. It does not modify native XRPL or isolated x402 tables. The
native issued-RLUSD migration profile is maintained separately and must be
reconciled before any deployment plan allocates additional numbers.

This repository contains no copied event starter bundle. The implementation is
based on the documented public protocol shape and uses the independently pinned
`viem` package for ABI and EIP-712 primitives. Live RPC checks, wallet signing,
merchant enrollment, funding, settlement, remote migrations, and deployment are
not part of this code-only slice.
