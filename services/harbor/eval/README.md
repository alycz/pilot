# Harbor MCP evaluation

`golden.jsonl` contains exactly 30 deterministic questions covering reads,
quotes, transaction builders, delegated execution, owner approvals, and
revocation. `run.mjs` calls only Harbor's public `search` and `execute` MCP
tools through `@modelcontextprotocol/sdk`; it does not use an IDE or require a
human during a run. The golden run writes test build and pending-approval rows
to the scoped D1 principal, but it never signs or submits an XRPL transaction.

## Golden score

Set `HARBOR_MCP_URL` (or pass `--url`) and make one deployed bearer credential
available as `HARBOR_API_KEY=principal:key`. The runner also accepts the first
pair in `HARBOR_API_KEYS`, as used by `.dev.vars`. Export the fresh funded
safety-owner address for live-backed account reads; the signing seed is not
read in golden mode:

```sh
set -a
. /absolute/private/pilot/harbor-secrets/h-safety.env.local
set +a
export HARBOR_EVAL_READ_ACCOUNT="$H_SAFETY_TEST_OWNER_TESTNET_ADDRESS"
```

```sh
node eval/run.mjs --url https://<worker>.workers.dev/mcp
```

The standalone command assumes the configured principal already has an active
or revoked Harbor link for `HARBOR_EVAL_READ_ACCOUNT`, because the required
approval cases evaluate real stored builds. For a fresh principal, use the
guarded `--live` workflow below: it establishes and verifies the link first,
executes the delegated OfferCreate, and then scores all 30 golden cases.

The command exits non-zero below 27/30 or when any required live-backed case
fails. Required cases exercise successful deployed ledger reads, order-book
depth, a simulated transaction build, `tx.execute` producing a real pending
owner approval, transaction status, and the unlinked-account revocation guard.
The public fallback account is useful for local shape checks only and is not a
substitute for the funded address in hosted acceptance.

## Live delegated OfferCreate

This mode changes testnet or devnet state. It never runs unless every guard
below is present. It deliberately refuses to fall back to `TEST_WALLETS_*`,
because those bootstrap fixtures may be retired.

Use the existing fresh safety owner without copying its credentials into the
repository or `.dev.vars`. Source its local secret file into only the current
shell, then set the explicit run guards. The seed and signed blobs must never
be printed, passed as command-line arguments, or uploaded as Worker secrets:

```sh
set -a
. /absolute/private/pilot/harbor-secrets/h-safety.env.local
set +a
export HARBOR_EVAL_OWNER_CONFIRM="$H_SAFETY_TEST_OWNER_TESTNET_ADDRESS"
export HARBOR_EVAL_FRESH_ACCOUNT=true
export HARBOR_EVAL_NETWORK=testnet
export HARBOR_EVAL_LIVE=delegate-offercreate-test-only
export HARBOR_EVAL_OWNER_ACTION=sign-delegateset-and-submit
```

The runner accepts `H_SAFETY_TEST_OWNER_TESTNET_ADDRESS` and
`H_SAFETY_TEST_OWNER_TESTNET_SEED` only on testnet. A separate devnet fixture,
if ever approved, must be passed as `HARBOR_EVAL_FRESH_OWNER_WALLET` JSON in
the process environment without persisting it.

Prerequisites and validated public order-book liquidity are checked before
`account.link` mutates state:

- the network is exactly `testnet` or `devnet`;
- the selected network is passed explicitly with every unsigned owner relay;
  Harbor verifies the signed account against the authenticated principal's
  matching account link before using that test-network route;
- the address matches the locally derived wallet address;
- the account exists and is faucet-funded;
- it has an unfrozen trust line with capacity to receive at least 10 units of
  the configured stablecoin;
- the validated XRP/stable order book has at least 10 stable units of funded
  liquidity;
- the account has enough XRP for the hard 50 XRP spend ceiling after current
  and anticipated owner reserves plus conservative owner-action fee budgets;
- policy allows the stable issuer, the selected test network, and autonomous
  `OfferCreate` execution for the simulated build's actual USD notional. The
  runner does not relax or replace the scoped policy.

Then run:

```sh
node eval/run.mjs --url https://<worker>.workers.dev/mcp --live
```

After the public prerequisites pass, the runner calls `account.link`, signs the
returned `DelegateSet` locally, and relays the signed blob through `tx.submit`.
Before creating a delegation, it directly simulates a Fill-or-Kill
`OfferCreate` that buys exactly 10 stable
units with a hard 50 XRP maximum spend and invokes `tx.execute` with a fresh
idempotency key. This is an explicitly bounded limit-order acceptance path,
not a `tx.swap` quote: generic raw `OfferCreate` builds have no market-relative
`est_slippage_bps`, so the policy's slippage rule does not price this order.
Safety instead comes from the independently validated 50 XRP ceiling, atomic
full-fill flag, exact 10 RLUSD receive amount, funded public depth, successful
simulation, and exact post-validation balance increase. The runner leaves the
scoped policy unchanged. After the grant validates, it also requires the
delegate fee payer to retain conservative execution-fee headroom. Because the
owner-signed grant consumes the pre-link build's owner sequence, the runner
rebuilds the identical Fill-or-Kill offer after grant validation and re-checks
its current USD notional against the same unchanged policy before execution. It then
scores the complete 30-case
golden corpus. The runner reads validated account history through MCP and
requires the transaction to have
`Account` equal to the budget owner and `Delegate` equal to the linked
delegate. The history read is bounded to recent delegated `OfferCreate`
transactions to keep deployed MCP output small. It also re-reads the validated trust line and requires the RLUSD
balance to have increased by exactly 10. Fill-or-Kill prevents a partial fill,
and a killed or otherwise non-exact result cannot pass acceptance. It never
prints the owner signing material or signed blobs.

The owner does not need a pre-existing RLUSD balance for this acceptance path.
The trust line is required so the exact-output purchase can receive RLUSD.

To revoke immediately after verification, add the independent owner-action
acknowledgement and `--revoke`:

```sh
HARBOR_EVAL_REVOKE_ACTION=sign-revoke-and-submit \
  node eval/run.mjs --url https://<worker>.workers.dev/mcp --live --revoke
```

`--revoke` prepares an empty-permission `DelegateSet`, signs it locally,
submits it through Harbor, and requires `account.status` to report `revoked`.
The revoke path is installed before `account.link` and runs from a `finally`
block. If link acquisition or local grant validation fails, cleanup re-reads
ledger-backed status and can sign only a bounded empty-permission revocation
for the stored active or suspended delegate; it never signs an unreviewed
grant. Later grant-status, build, execution, or validation failures use the
same cleanup, and failure to confirm revocation makes the whole run fail.
