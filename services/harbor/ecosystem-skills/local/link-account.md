# Link an account safely

Use this playbook only on XRPL Testnet or Devnet. Refuse mainnet and any request involving real assets. Link a separately funded **budget account**; never link the wallet that holds the user's main funds.

## Procedure

1. Confirm the selected network is `testnet` or `devnet`, `PermissionDelegationV1_1` is enabled there, and the budget account exists. Read the current network reserve instead of assuming one; a `Delegate` ledger entry consumes owner reserve.
2. Keep key ownership separated. Harbor may generate and retain its delegate key, encrypted at rest, but must never accept, request, log, store, or return an owner seed, private key, or mnemonic. Never display or export the delegate seed either. Fund test accounts and the delegate from the matching faucet only.
3. Call `account.link({ owner, network })` unless the user explicitly requests a narrower safe permission set. The fixed default is `OfferCreate`, `OfferCancel`, `TrustSet`, `AMMDeposit`, `AMMWithdraw`, `EscrowFinish`, and `CheckCash`.
4. Reject duplicate, unknown, non-delegable, or more than 10 permissions. Never grant `Payment`, `EscrowCreate`, `CheckCreate`, `PaymentChannelCreate`, `PaymentChannelFund`, `NFTokenCreateOffer`, `PaymentBurn`, or `PaymentMint`; also reject every `Vault*`, `Loan*`, `LoanBroker*`, `AccountSet`, `SetRegularKey`, `SignerListSet`, `DelegateSet`, `AccountDelete`, and outer `Batch` permission.
5. Inspect the `AccountLink.delegate_set_tx` unsigned `DelegateSet`: `Account` must equal the budget account, `Authorize` must equal Harbor's delegate, and `Permissions` must exactly match the reviewed set. Check `Fee`, sequence, and `LastLedgerSequence` immediately before wallet approval. `account.link` returns an `AccountLink`, not a `TxBuild`, so do not invent `preflight` or `simulate` fields on that result. If the discovered Harbor catalog exposes a separate unsigned-transaction simulation operation, call it with this exact transaction and require `tesSUCCESS`; otherwise rely on the field checks and the owner wallet's review. Treat XRP fields such as `Fee` as decimal **drops strings**. If an issued-token amount appears in related work, require `{ "currency": "...", "issuer": "...", "value": "..." }`, all values as strings; codes longer than three characters must be 40-character hexadecimal.
6. Present the unsigned transaction for signing in the owner's wallet, then **stop**. Do not sign for the owner, ask for owner key material, or continue as if approval were granted. After the owner returns a signed blob, submit that blob only. If any Harbor call returns `needs_approval`, show its owner-signable `tx_json` and expiry and stop; if it returns `blocked`, show the reasons and do not retry.
7. Do not call the link active from a preliminary submit response. Wait until the transaction is in a validated ledger with final result `tesSUCCESS`, then call `account.status({ owner, network })`. Finish only when the status is `active` and the on-ledger permissions exactly match the reviewed set. Otherwise report the final code or mismatch and leave the link unusable.

## Primary XRPL references

- [Permission Delegation](https://xrpl.org/docs/concepts/accounts/permission-delegation)
- [DelegateSet transaction](https://xrpl.org/docs/references/protocol/transactions/types/delegateset)
- [Permission values](https://xrpl.org/docs/references/protocol/data-types/permission-values)
- [Account reserves](https://xrpl.org/docs/concepts/accounts/reserves)
- [Currency formats](https://xrpl.org/docs/references/protocol/data-types/currency-formats)
- [`simulate` method](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/simulate)
- [Transaction finality](https://xrpl.org/docs/concepts/transactions)
