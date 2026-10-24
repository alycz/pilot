# Provide AMM liquidity safely

Add liquidity to an existing XRPL AMM on testnet or devnet only, after checking the pool, token issuers, price, expected LP position, and every simulated ledger change.

## Safety boundary

- Never execute this playbook on mainnet or with assets that have real value.
- Use the connected budget account, not a main holdings account.
- Never ask for or accept an owner seed, private key, or mnemonic. If an owner signature is required, return the unsigned approval to the user's connected wallet.
- `AMMDeposit` may be delegated only when the account link is active, its on-ledger permissions include `AMMDeposit`, and Harbor policy returns `execute`. A missing permission or `needs_approval` result is not permission to bypass the wallet.
- Treat a policy `block` as final. Do not weaken policy, substitute an issuer, or retry with altered amounts to evade it.

## Represent the request exactly

Use `search` for `tx.ammDeposit`, `amm.info`, `amm.position`, `tokens.lookup`, and `tx.status` before calling them; follow the returned signatures rather than guessing arguments.

- Identify each pool asset by the full issue. XRP is `{ "currency": "XRP" }`. An issued token is `{ "currency": "USD", "issuer": "r..." }`; the issuer is part of the asset identity. A currency code longer than three characters must use its 40-character hexadecimal form.
- XRP amounts are strings in drops, so 10 XRP is `"10000000"`. Issued-token amounts are `{ "currency": "USD", "issuer": "r...", "value": "10" }`, with a decimal string value. Never use floating-point numbers for ledger amounts.
- Keep the requested asset order aligned with the builder's returned signature. Confirm that both issues exactly match the pool returned by `amm.info`.
- Prefer a two-asset deposit in the pool's current ratio. With `tfTwoAsset`, `Amount` and `Amount2` are maximums and the ledger can consume less of one side to preserve the ratio. A two-asset proportional deposit has no AMM deposit fee.
- Use a single-asset mode only when the user explicitly requests it and accepts its extra cost and pool-price effect. Prefer the builder's effective-price-limited mode (`tfLimitLPToken`, with `Amount` and `EPrice`) over an unbounded single-asset deposit. Do not combine fields or flags from different deposit modes.

The valid modes and field combinations are defined by the official [`AMMDeposit` transaction reference](https://xrpl.org/docs/references/protocol/transactions/types/ammdeposit).

## Preflight the pool and assets

Before building:

1. Require `network` to be exactly `testnet` or `devnet`. Reject `mainnet` even if a read operation can see it.
2. Read `amm.info` and `amm.position` at a recent validated ledger. Record both reserves, the AMM trading fee, total LP-token supply, the account's LP balance, and whether the pool is empty.
3. Compare the pool's implied spot price with a fresh independent DEX book or quote. Show the difference and expected price movement from this deposit. Stop if the pool is unusually shallow, the price is stale or materially divergent, or the quote cannot be verified.
4. Run `tokens.lookup` for every issued asset. Require the exact expected issuer and the policy issuer allowlist. Reject flagged or unverified lookalikes and any token whose issuer can claw back it, because clawback-enabled trust-line tokens are not eligible AMM assets.
5. Check the depositor and AMM asset trust lines. Stop on global, individual, or deep freeze; missing authorization; MPT lock; or any other issuer restriction. `RequireAuth` tokens need an authorized trust line, and Harbor policy normally blocks RequireAuth issuers.
6. Check spendable balances and the current reserve requirement. A successful first deposit can create a limit-zero trust line for LP tokens, so the account needs enough XRP for any reserve increase as well as the transaction fee.
7. Present the two maximum input amounts, current pool ratio, estimated LP tokens and pool share, AMM trading fee, effective price or price bound, reserve delta, and worst acceptable result. Obtain explicit confirmation for any single-asset deposit or material price divergence.

Issuer authorization and freezes can prevent either side of a deposit; see [Authorized Trust Lines](https://xrpl.org/docs/concepts/tokens/fungible-tokens/authorized-trust-lines) and [Freezing Tokens](https://xrpl.org/docs/concepts/tokens/fungible-tokens/freezes).

## Explain the LP risk before execution

LP tokens represent a proportional claim on the pool, not a promise to return the same quantities deposited. Trades continuously change the pool's asset mix. If the relative market price moves, withdrawing later can be worth less than simply holding the two assets; this currency risk is commonly called impermanent loss, and it becomes permanent on withdrawal. Trading fees accrue to the pool and may offset some loss, but neither volume nor profit is guaranteed. Thin pools add manipulation and price-impact risk, and issuer freeze or authorization controls can make LP tokens unusable or block withdrawal.

The XRPL's constant-product pricing, LP-token ownership, issuer restrictions, fees, and currency risk are described in [Automated Market Makers](https://xrpl.org/docs/concepts/tokens/decentralized-exchange/automated-market-makers).

## Build, simulate, and execute

1. Call `tx.ammDeposit` with the confirmed network, budget account, exact issues, mode, and string amounts. The builder must return an unsigned `TxBuild`; never add signature fields or secret material.
2. Inspect every `preflight` entry. Continue only if all checks pass and their details still match the pool, issuer, balances, trust lines, reserve, and requested bounds reviewed above.
3. Require `simulate.engine_result === "tesSUCCESS"` and `simulate.applied === false`. Inspect simulated metadata for debited asset amounts, LP tokens created, trust-line creation, fee, and reserve effects. A dry run is not a guarantee because ledger state can change before submission; rebuild if the pool changes materially or `LastLedgerSequence` is stale. The official [`simulate` method](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/simulate) documents this limitation.
4. Confirm that the final `tx_json` contains `TransactionType: "AMMDeposit"`, the budget account, the intended pair and mode, no unexpected fields, and amounts no larger than approved. Confirm the summary's fee, reserve delta, USD value, and estimated slippage are within policy.
5. Call `tx.execute` once with the `build_id` and a stable, unique idempotency key for this intent. Reuse that same key if transport fails.
6. If Harbor returns `executed`, retain the hash and ledger index. If it returns `needs_approval`, show the complete human-readable transaction, limits, expiry, and policy reasons, then stop for owner approval in the connected wallet. If it returns `blocked` or `failed`, do not submit or silently rebuild around the result.

## Verify the final result

Do not report success from a submit response alone. Query `tx.status` by hash until it is final, and require `validated: true` (or Harbor's equivalent final validated state) plus metadata `TransactionResult: "tesSUCCESS"`. A non-validated result is not final according to the official [`tx` method](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/tx).

After validation, re-read `amm.info`, `amm.position`, and the account's trust lines. Report the actual amounts deposited, LP tokens received, resulting pool share and ratio, transaction fee, validated ledger index, and explorer link. If the hash expires without validation, or metadata differs materially from the confirmed simulation, report the failure or discrepancy and do not claim liquidity was added.
