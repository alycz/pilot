# Pilot local XRPL Testnet x402 merchant

This directory contains a code-only FastAPI merchant for the single fixed resource:

`GET http://127.0.0.1:8000/api/x402/compare`

It advertises one T54 XRPL x402 v2 `exact` option on Testnet (`xrpl:1`) for native XRP. The generic merchant entrypoint defaults to `5000` drops and retains its reusable configurable ceiling of `100000` drops and configurable classic-address receiver. The reviewed isolated entrypoint fails closed unless the price is exactly `5000` drops and the receiver is exactly `rnSXTVWEhMKhECNUEENzUi9QuMFoFpKghr`. Both entrypoints cap the payer fee receipt at `100` drops. Network, asset, resource URL, and facilitator target cannot be widened.

The local integration default SourceTag is `2610240`, matching Harbor's current checked-in local x402 profile. `profile_contract.py` compares that profile and its exact reviewed loopback origin directly to the active environment-resolved merchant configuration. For the isolated profile it also requires the exact price and receiver. The isolated `isolated_compare:app` entrypoint independently enforces the same constraints at app construction, so skipping the preflight cannot start that lane with changed payment terms.

## Security boundary

- Only the fixed GET route is paid. A wrong method reaches FastAPI's `405` without verification.
- The challenge and paid request are bound to the complete ResourceInfo, exact requirements, durable invoice ID, source tag, and fixed URL.
- Payment headers use strict canonical padded Base64, UTF-8 JSON, and Harbor's 24 KiB encoded / 16 KiB decoded limits.
- SQLite atomically claims an invoice with a generation lease and durably records the verified transaction hash and exact receipt before the one allowed settlement attempt. A stale worker cannot release or settle a newer claim. After a crash, timeout, or restart, exact replay performs only read-only reconciliation of that hash against the fixed official Testnet endpoint; it never calls settlement again.
- Unpaid invoices expire. Cached successful delivery remains available for Harbor recovery after the issue window expires.
- The runtime facilitator can call only `https://xrpl-facilitator-testnet.t54.ai/verify` and then `https://xrpl-facilitator-testnet.t54.ai/settle`. Paid delivery additionally requires an independently validated exact transaction from the fixed `https://s.altnet.rippletest.net:51234/` read-only `tx` lookup. Redirects are disabled and every remote response is capped at 16 KiB.
- Importing the module does not create or migrate storage. Startup uses the fixed, owner-only `.local/invoices.sqlite3` path and rejects symlinked storage. Anonymous loopback requests reuse one exact matching unexpired challenge; changed receiver, price, tags, timeout, or ResourceInfo creates a new invoice. Expired unsigned rows are pruned. Explicit caps of 128 active and 512 total retained invoices plus an 8 MiB WAL checkpoint limit bound local database growth. On exhaustion, new invoices fail closed while every delivered, settlement-unknown, or confirmed-not-included audit row and its replay/reconciliation path remain intact.
- Invoice TTL never proves that a submitted payment failed. Before issuing a challenge, the merchant durably records the first ledger in which its invoice-bound transaction could appear. A hash-only lookup recovers validated success immediately. Absence becomes terminal only after a validated ledger passes `LastLedgerSequence` and a second lookup confirms `searched_all: true` across the complete persisted issuance-to-expiry window. New windows are capped at the XRPL `tx` method's 1,000-ledger limit. Legacy receipts without these bounds are presence-only: they can recover a found validated payment but can never terminalize absence.
- Requests require the literal loopback client, Host, and optional Origin contract. Proxy forwarding headers, alternate hosts, and non-loopback clients are rejected.
- The verifier decodes the signed transaction before any remote request and enforces Payment type, destination, amount, SHA-256 InvoiceID binding, SourceTag, LastLedgerSequence, fee ceiling, and forbidden-field checks.
- The delivered merchant JSON is the bounded object `{"comparison":["dex","amm"]}`. It contains no instructions or executable actions.
- This code creates no wallet, holds no secret, signs nothing, submits nothing, and has no faucet, mainnet, deployment, or cloud path.

## Compatibility contract

The current Harbor local x402 adapter's paid request carries:

```json
{
  "x402Version": 2,
  "resource": {"url": "http://127.0.0.1:8000/api/x402/compare"},
  "accepted": {
    "scheme": "exact",
    "network": "xrpl:1",
    "asset": "XRP",
    "payTo": "r...",
    "amount": "5000",
    "maxTimeoutSeconds": 60,
    "extra": {"sourceTag": 2610240, "invoiceId": "..."}
  },
  "payload": {"signedTxBlob": "..."}
}
```

The published `x402-xrpl` 0.3.4 and 0.4.0b1 FastAPI middleware was inspected but is not used here because it does not bind the complete ResourceInfo, its default invoice store is not durable or atomic, and verify-only mode neither consumes invoices nor emits `PAYMENT-RESPONSE`. The newer generic x402 Foundation XRPL draft also adds controls that the current approved Harbor wire contract rejects. This merchant deliberately matches that wire contract rather than silently adding incompatible fields.

## Fixture evidence versus real paid acceptance

The tests under `tests/` use `FixtureReceiptVerifier`, clearly labeled as offline-only. They prove the local state machine and HTTP contract:

`402 challenge -> fixture verification -> fixture settlement receipt -> 200 -> cached exact replay`

They do **not** prove a real XRPL payment, a public facilitator response, or paid acceptance. Although the runtime path is implemented for Harbor compatibility, this task did not call the facilitator, an XRPL endpoint, a faucet, or any settlement endpoint. A real acceptance claim requires a separately authorized Testnet run that observes both a successful facilitator settlement and Harbor's independent validated-ledger evidence. Harbor's receipt remains the source of the validated transaction hash and ledger index; this merchant does not invent those fields.

## References and credits

- [XRPL Agentic Payments with x402](https://xrpl.org/docs/agents/agentic-payments-x402)
- [XRPL `tx` method](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/tx), including the 1,000-ledger range and `searched_all` semantics
- [T54 XRPL exact scheme](https://xrpl-x402.t54.ai/docs/xrpl-scheme)
- [x402 Foundation XRPL exact draft](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_xrpl.md)
- Official PyPI packages pinned in `requirements.txt`: FastAPI, HTTPX, Uvicorn, and xrpl-py
- Harbor's current local x402 profile and adapter, especially `wrangler.local-x402.jsonc`, `src/adapters/x402.ts`, and `src/exec/x402-runtime.ts`
