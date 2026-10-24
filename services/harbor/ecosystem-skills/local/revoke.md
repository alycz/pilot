# Revoke or suspend a delegate

Stop autonomous Harbor execution and remove a delegate's on-ledger permissions with an owner-signed empty-permissions `DelegateSet`.

Use this playbook only on testnet or devnet. Never use it for mainnet, real assets, or an owner seed, private key, or mnemonic.

## When to use it

- Use revocation when the owner wants to disconnect Harbor or replace a delegate.
- Treat `suspended` as an incident state. Harbor's watcher sets it after finding a validated delegated transaction for the budget account that does not match an execution Harbor recorded. A suspended link must refuse further delegated execution and expose the prepared revocation transaction.
- Suspension is not on-ledger revocation. The delegate retains its ledger permissions until an empty-permissions `DelegateSet` is owner-signed, submitted, and validated.

## Immediate containment

1. Call `account.status` and record the owner address, delegate address, network, granted permissions, and link status. Continue only on testnet or devnet.
2. If the status is `suspended`, do not execute, retry, or approve pending autonomous actions. Surface the foreign-transaction warning and use the stored `revoke_tx` if it is current.
3. If the owner initiated the disconnect while the link is active, call `account.revoke` to obtain the unsigned revocation transaction. This prepares the transaction; it does not sign it and does not prove that revocation has reached the ledger.
4. Cancel or ignore pending agent work for that link. A policy `blocked` result remains terminal and must never be retried. A `needs_approval` result must be returned to the user and the agent must stop; revocation must not be hidden inside a different approval.

## Verify the revocation transaction

Before opening the wallet, require all of the following:

- `TransactionType` is `DelegateSet`.
- `Account` is the owner/budget account.
- `Authorize` is the exact delegate being removed.
- `Permissions` is an empty array.
- The network is testnet or devnet and the connected wallet account matches `Account`.
- Any Harbor expiry and the transaction's `LastLedgerSequence` are still current.

Reject any mismatch or extra permission. XRPL specifies that a `DelegateSet` replaces the delegate's complete permission set; an empty `Permissions` array deletes an existing Delegate ledger entry. It fails with `tecNO_ENTRY` if that entry is already absent.

## Owner signing and validation

1. Present the exact `DelegateSet` fields and the consequence—removing all permissions for this delegate—to the user.
2. Send the unchanged transaction to the connected owner wallet in **sign-only** mode. The user reviews and signs; the wallet must not submit it directly through an opaque path.
3. Never ask the user to paste a seed, private key, or mnemonic. Never send owner signing material to Harbor. If the wallet rejects `DelegateSet`, the only permitted fallback is the explicitly configured browser testnet developer signer, for this transaction type on a test network; its key stays client-side for the test session.
4. Relay the signed blob through `tx.submit`. Reject a decoded transaction whose fields differ from the prepared revocation, apart from the signature fields. Do not repair, rewrite, or resign a tampered blob.
5. Wait for a validated ledger result, then call `account.status`. Completion means the Delegate ledger entry is absent and Harbor reports the link as `revoked`; a submit response by itself is not completion.
6. If `tecNO_ENTRY` is returned, verify on-ledger state and Harbor status rather than repeatedly submitting. The desired permission entry may already be absent.

## After revocation

- Keep the link non-active while the transaction is pending, expired, rejected, or failed. No delegated transaction may be signed unless the link is `active` and the transaction type is both granted on-ledger and allowed by policy.
- If a prepared revocation expires, request a newly prepared transaction and repeat owner review. Do not modify the old signed blob or automate repeated wallet prompts.
- Do not reactivate a suspended delegate in place. Investigate the foreign activity, revoke it, and require an explicit fresh link flow with a newly reviewed `DelegateSet` before autonomous execution can resume.

## Official XRPL references

- [DelegateSet transaction](https://xrpl.org/docs/references/protocol/transactions/types/delegateset) — `Authorize`, exact-set `Permissions`, empty-array revocation, and `tecNO_ENTRY`.
- [Permission Delegation](https://xrpl.org/docs/concepts/accounts/permission-delegation) — the delegator can update or revoke permissions and delegates can act only within granted permissions.
- [Reliable transaction submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission) — validation, finality, status checks, and `LastLedgerSequence`.
