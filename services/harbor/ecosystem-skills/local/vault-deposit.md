# Deposit into a Single Asset Vault safely

Deposit test assets into an XRPL Single Asset Vault on Devnet or Lending-Devnet, using a simulated unsigned build and an explicit owner-wallet approval.

## Safety boundary

- This workflow is limited to `devnet` and `lending-devnet`. Reject `mainnet` and `testnet`, even if a read endpoint returns vault data there. Prefer Devnet; use Lending-Devnet only when Harbor's amendment check identifies it as the configured fallback.
- Require the `SingleAssetVault` amendment on the selected network before building. A vault used by the Lending Protocol also requires `LendingProtocol` and `LendingProtocolV1_1`. Preserve a `devnet-only` caveat in the result and continue only on the named test network; stop on `amendment-pending`.
- Every `Vault*` transaction, including `VaultDeposit`, is non-delegable. The depositing account's owner must review and sign in a connected wallet. Do not add `VaultDeposit` to delegated permissions or let a delegate sign it. Official permission values list all Vault transaction types as [non-delegable](https://xrpl.org/docs/references/protocol/data-types/permission-values).
- Never ask for or accept an owner seed, private key, or mnemonic. Harbor receives only the owner-signed transaction blob after wallet approval; an approval request is never a request for secret material.
- Use only a funded devnet budget account and valueless devnet assets. A vault owner is the account that manages the vault; it is distinct from the owner of the depositing account. A public vault does not require the vault manager to approve each deposit, while a private vault requires valid credentials.

## Represent the deposit exactly

Use `search` for `vault.info`, `amendments.status`, `tokens.lookup`, `tx.vaultDeposit`, `tx.execute`, `tx.submit`, and `tx.status`, and follow the discovered signatures exactly.

- `VaultID` is the selected vault's 64-character hash. Never choose a vault from its display name alone.
- `Amount` must match the vault's on-ledger `Asset` exactly. For XRP, use a drops string such as `"10000000"` for 10 XRP. For a trust-line token, use `{ "currency": "USD", "issuer": "r...", "value": "10" }`. Values remain strings; never use floating-point numbers.
- XRP is `{ "currency": "XRP" }`. An issued token includes its exact issuer. Currency codes longer than three characters use their 40-character hexadecimal form.
- A vault can hold XRP, a trust-line token, or an MPT. Use an MPT only if the current `tx.vaultDeposit` signature explicitly supports its issue and integer-unit amount; never invent an encoding. For XRP and MPT vaults the share scale is fixed at zero; trust-line-token vaults can set a different scale.

The required `VaultID` and `Amount` fields are defined in the official [`VaultDeposit` transaction reference](https://xrpl.org/docs/references/protocol/transactions/types/vaultdeposit).

## Inspect the vault and depositor

Before building:

1. Read `amendments.status` on the selected Devnet endpoint. Stop unless `SingleAssetVault` is enabled, and for a lending-connected vault stop unless both Lending Protocol amendments are enabled.
2. Read `vault.info` from a validated ledger. Match the exact `VaultID`, vault pseudo-account, vault owner, underlying `Asset`, public/private access, open- or closed-ended kind, current phase, deposit cap, total and available assets, outstanding shares, `LossUnrealized`, scale, withdrawal policy, share-transfer setting, and relevant dates.
3. Permit a deposit only for an open-ended vault or during a closed-ended vault's subscription phase. Investment and redemption phases do not accept deposits.
4. For a private vault, verify the depositing account has valid, unexpired credentials for the share's Permissioned Domain. Do not treat an existing share balance as proof that credentials are still valid. Public vaults do not require this credential check.
5. Confirm that the deposit will not exceed `AssetsMaximum`, allowing for current vault assets and ledger rounding. Reject zero, negative, unrepresentable, or dust amounts.
6. Check the depositor's spendable underlying balance and enough XRP for the fee and reserve effects. For a trust-line token, verify the exact issuer, trust line, authorization, limits, and freeze state. For an MPT, verify authorization and lock state. Also reject a frozen/locked vault pseudo-account relationship.
7. Run `tokens.lookup` for an issued underlying asset. Require the policy issuer allowlist, show RequireAuth, freeze, clawback, transfer restrictions, and any risk flags, and stop on an unexpected or unverified issuer.
8. Estimate shares using current validated vault state, then label the estimate. Deposits after the first are proportional and round down; unrealized loss affects the assets actually taken and share value. Show the pre-deposit share exchange rate, estimated shares, rounding, cap headroom, withdrawal restrictions, lockup dates, and the maximum underlying amount before requesting approval.

Vault access, phases, share mechanics, loss treatment, and issuer controls are described in [Single Asset Vaults](https://xrpl.org/docs/concepts/tokens/single-asset-vaults) and the [Vault ledger entry](https://xrpl.org/docs/references/protocol/ledger-data/ledger-entry-types/vault).

## Explain the risks before approval

Vault shares are a claim on vault assets, not a fixed-interest promise. The underlying asset does not earn yield by itself; returns and losses depend on the protocol using the vault. Share value can fall when the vault records losses, and a closed-ended vault can block withdrawal during its investment phase. Rounding can reduce the accepted asset amount or shares issued. Private-vault credentials can expire for new deposits, transfer settings can prevent moving shares, and underlying issuer freeze, lock, authorization, or clawback controls can affect the assets and shares. Show these risks and the vault's specific dates and policies to the owner before signing.

## Build and simulate without signing

1. Call `tx.vaultDeposit` with the selected `devnet` or `lending-devnet` network, the depositing account, exact `VaultID`, and correctly typed string amount. The builder must return an unsigned `TxBuild` with `delegable: false`.
2. Inspect every `preflight` entry. Continue only if all pass and explicitly cover amendment status, vault phase and cap, asset match, credentials when private, issuer controls, balance, fee, reserve, and flag conflicts.
3. Require `simulate.engine_result === "tesSUCCESS"` and `simulate.applied === false`. Inspect simulated metadata for the actual asset debit, shares issued, vault changes, fee, and any new owned objects. Simulation does not reserve ledger state; rebuild after a material vault change or stale `LastLedgerSequence`. See the official [`simulate` method](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/simulate).
4. Verify the final unsigned `tx_json` contains `TransactionType: "VaultDeposit"`, the depositing account, exact `VaultID`, intended `Amount`, `Flags: 0` unless the current builder and protocol documentation require otherwise, a reasonable fee, and a bounded `LastLedgerSequence`. Reject any `Delegate`, signature, destination, asset substitution, or amount increase.

## Require owner approval and submit

1. Call `tx.execute` with the `build_id` and a stable, unique idempotency key. Because `VaultDeposit` is non-delegable, the only acceptable outcome before signing is `needs_approval` with an `approval_id`, unsigned `tx_json`, expiry, and policy reasons.
2. Present the exact vault, underlying amount, estimated shares and rounding, loss and lockup information, fee, reserve delta, expiry, and every policy reason. Stop and wait for the owner to approve or reject in the connected wallet.
3. On rejection or expiry, do not submit. On approval, accept only the wallet-produced signed transaction blob. Never accept signing keys or ask the owner to paste wallet recovery material.
4. Relay the signed blob with `tx.submit` and the matching `approval_id`. Harbor must reject a blob whose approved fields were changed; never resubmit a tampered or expired approval.

## Verify the final result

Do not treat signing or submission as success. Query `tx.status` by hash until final. Require `validated: true` (or Harbor's equivalent final validated state) and metadata `TransactionResult: "tesSUCCESS"`; otherwise report the actual failure. The official [`tx` method](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/tx) notes that unvalidated data is not final.

After validation, re-read `vault.info` and the depositor's balances or objects. Confirm the validated ledger index, underlying amount actually taken, shares actually issued, updated vault totals and cap headroom, fee charged, transaction hash, and devnet explorer link. If the transaction expires without validation or the ledger changes do not match the reviewed simulation, report the discrepancy and do not claim the deposit succeeded.
