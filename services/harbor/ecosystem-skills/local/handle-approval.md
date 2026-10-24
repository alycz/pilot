# Handle an owner approval

Complete a Harbor `needs_approval` result without giving the agent or Harbor custody of the owner's signing keys.

Use this playbook only on testnet, devnet, or the configured valueless Lending-Devnet fallback. Never use it for mainnet, real assets, or an owner seed, private key, or mnemonic.

## Safety boundary

- A `needs_approval` result is a hard pause. Present the returned approval to the user, set the UI state to awaiting approval, and end the agent/tool turn. Do not call another build, execution, signing, or submission operation in that turn.
- Do not convert `needs_approval` into delegated execution. The owner must review and sign with their connected wallet.
- A `blocked` result is terminal for that request. Explain every failed policy or pre-flight rule and do not retry, loosen policy, rebuild, split the amount, or substitute another route.
- No model tool signs transactions. Harbor and the application must never ask for, accept, log, store, or return an owner seed, private key, or mnemonic.

## Approval procedure

1. Inspect the `tx.execute` response. Continue only when `status` is exactly `needs_approval` and the response contains `approval_id`, `tx_json`, `expires_at`, and the policy reasons.
2. Show the user a plain-language summary alongside the exact transaction fields the wallet will display: network, `TransactionType`, source account, destination or venue, assets and amounts, flags, fee, sequence, and `LastLedgerSequence` when present. Explain which policy or delegability rule required owner approval.
3. Confirm that the selected network is testnet, devnet, or Harbor's configured `lending-devnet` fallback and that the connected wallet account equals `tx_json.Account`. Reject any other network or account mismatch locally. Never request secret-key material as a workaround.
4. Check `expires_at` immediately before opening the wallet. If it has passed, discard the approval and its transaction. Do not submit it or silently retry it. A still-wanted action requires a new, explicit user request and a fresh build and approval.
5. Send the returned `tx_json` unchanged to the connected owner wallet in **sign-only** mode. The wallet must not submit it. The user reviews the wallet's transaction details and either signs or rejects it.
6. If the user rejects or closes the wallet request, stop. Do not reopen the wallet or retry unless the user explicitly asks.
7. Post the signed blob and the matching `approval_id` to `tx.submit`. Harbor decodes the blob and requires the signed transaction to match the stored approved JSON, apart from signature fields such as `SigningPubKey` and `TxnSignature`. A changed amount, destination, account, flags, fee, sequence, memo, network field, or any other approved field is tampering: reject and stop.
8. Treat a successful submit response as provisional. Show success only after Harbor reports the transaction in a validated ledger. XRPL submission guidance distinguishes a server's provisional response from the final result recorded in a validated ledger.

## Expiry, errors, and retries

- Refuse an expired approval even if the wallet produced a signature. `LastLedgerSequence` is an additional ledger-enforced ceiling; if either the Harbor approval or transaction has expired, do not submit it.
- Never edit and re-sign the old transaction to extend its lifetime. A fresh user request must produce a newly built, simulated, policy-checked transaction and a new approval identifier.
- On a tamper mismatch, wrong signer, wrong network, malformed blob, or failed validation, preserve the error for the user and stop. Do not fall back to a delegate signature.
- Reusing an approval identifier or replaying a signed blob is not a retry strategy. Query status by hash when the result is uncertain; do not create a replacement transaction until the prior transaction has an authoritative final outcome.

## Official XRPL references

- [Reliable transaction submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission) — provisional versus validated results, idempotency, verification, and `LastLedgerSequence`.
- [Transaction common fields](https://xrpl.org/docs/references/protocol/transactions/common-fields) — account, fee, sequence, signing, network, and expiration fields.
- [Permission Delegation](https://xrpl.org/docs/concepts/accounts/permission-delegation) — delegated authority and its limits.
