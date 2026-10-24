# Swap safely

Use this playbook only on XRPL Testnet or Devnet and only with a linked budget account. Refuse mainnet, real assets, and swaps from the user's separate main-holdings account.

## Procedure

1. Require an `active` link, an on-ledger `OfferCreate` permission, and a policy that allows the network, transaction type, issuer, requested size, daily total, and slippage. Harbor must never accept, request, log, store, or return an owner seed, private key, or mnemonic, and must never expose its delegate seed.
2. Normalize assets before quoting. XRP amounts in transaction fields are decimal **drops strings**. Issued-token amounts are `{ "currency": "...", "issuer": "...", "value": "..." }` with a string value and an exact issuer; currency codes longer than three characters are 40-character hexadecimal. Do not silently substitute issuers.
3. Read a fresh order book and token/trust-line state. Reject a missing trust line, an unallowlisted issuer, a RequireAuth issuer blocked by policy, insufficient spendable balance or reserve, an expired quote, or price impact above `max_slippage_bps`.
4. Build with `tx.swap`, not `tx.payment` and never a self-`Payment`. Verify the transaction is `OfferCreate` with `tfImmediateOrCancel`; include `tfSell` only when selling a fixed amount. Confirm `Account` is the budget account, the asset directions and amounts match the intent, the limit price is bounded by the quoted mid and maximum slippage, and `Fee`/reserve deltas are acceptable. A build must not contain owner signatures or owner key material.
5. Review every returned preflight item and require all to pass. Require simulation result `tesSUCCESS` before execution. Simulation is not settlement, and an immediate-or-cancel offer can return `tesSUCCESS` while filling nothing, so never describe a simulated result as a fill.
6. Call `tx.execute({ build_id, idempotency_key })` once with a unique stable idempotency key. Harbor may delegate-sign only if the link is active, `OfferCreate` is granted, and the policy verdict is `execute`.
7. Branch on the result:
   - `executed`: verify the hash appears in a validated ledger, the final transaction result is `tesSUCCESS`, and metadata supports the reported `filled` or `partial` outcome. Report actual received/spent amounts, not the quote.
   - `needs_approval`: present the owner-signable `tx_json`, policy reasons, and expiry, then **stop**. It must not contain `Delegate`. Do not sign, submit, or retry until the owner independently signs and returns the blob.
   - `blocked`: report every failed rule and do not retry or weaken policy.
   - `failed`: report the engine result and rebuild only for an explicitly stale `LastLedgerSequence`; never broaden permissions or slippage to force success.

## Primary XRPL references

- [OfferCreate transaction and flags](https://xrpl.org/docs/references/protocol/transactions/types/offercreate)
- [Permission Delegation](https://xrpl.org/docs/concepts/accounts/permission-delegation)
- [Currency formats](https://xrpl.org/docs/references/protocol/data-types/currency-formats)
- [Trust lines and issued tokens](https://xrpl.org/docs/concepts/tokens/fungible-tokens)
- [`simulate` method](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/simulate)
- [Reliable transaction submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission)
- [Transaction finality and metadata](https://xrpl.org/docs/concepts/transactions)
