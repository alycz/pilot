# NEAR integration boundary

Pilot preserves its existing model-agnostic MCP/REST harness and XRPL lane.
NEAR support is added as typed adapters, not as a replacement runtime and not
as a claim that every catalogued venue is executable.

## Implemented in source

- Harbor operations `near.intents.tokens`, `near.intents.quote`, and
  `near.intents.status` use the fixed official 1Click origin.
- `near.intents.quote` accepts only an `EXACT_INPUT`, public, dry request in the
  initial slice. It verifies the provider signature with the pinned official
  SDK and binds the complete echoed request before returning a Base58 quote
  hash. A dry quote has no deposit address and is never executable approval.
- Status reads carry the provider deposit address and memo together, verify the
  nested quote signature, and preserve provider-reported settlement states.
- Shared contracts distinguish provider signature verification from Pilot's
  principal-bound approval digest. The latter commits to exact asset IDs,
  atomic amounts, recipient, refund address, deposit metadata, policy,
  idempotency key, approval expiry, and provider refund-start deadline.
- A provider-neutral NEAR wallet facade and review card exist with signing and
  execution disabled by default. They contain no submit or broadcast method.
- `/demo/near-intents`, linked from the existing Integrations menu, provides an
  explicitly configured live read-only path for token inventory and verified
  dry quotes plus a visibly separate fixture-only approval/status walkthrough.
  Provider errors never fall back to fixtures, and neither path can enable
  execution.
- `@pilot/near-chain-signatures` pins `chainsig.js` 1.1.16 for a narrow NEAR
  Testnet -> XRP Testnet native-payment preparation/finalization boundary. It
  exposes no broadcast or generic signing method and remains off until an owner
  wallet and external Testnet acceptance lane are separately integrated.
- Optional NEAR AI configuration, live model-catalog discovery, fixed-origin
  read-only NEAR RPC, and an Earn discovery flow are implemented. Earn uses the
  standard tokens -> dry quote -> optional existing-settlement status path; it
  has no invented deposit endpoint.

## Not accepted or enabled

- 1Click has no testnet. No live quote, funded settlement, mainnet deposit,
  signed intent, limit order, wallet signature, or transaction submission was
  performed while implementing this slice.
- `SUCCESS` is provider-reported unless destination evidence is independently
  verified. Unknown or missing status never proves non-execution and never
  authorizes an automatic replacement payment.
- A NEAR function-call key allowance pays gas; it is not a token spending cap.
- NEAR AI privacy is operator-declared metadata until its attestation and E2EE
  path receive separate acceptance. It is not wired into live chat by default.
- Durable principal-bound executable-attempt storage, atomic asset-budget
  reservation, funded settlement reconciliation, and a reviewed mainnet
  acceptance lane remain future gates.
- IronHub is not integrated. Its current artifacts target the IronClaw WIT/WASM
  runtime and include broader write-capable surfaces than this slice needs.
  Shade Agents is deprecated and intentionally excluded.

## Configuration

All credentials stay server-side. See `.env.example` and
`services/harbor/.env.example`. Empty or disabled configuration fails closed.
The browser cannot select provider origins, inject credentials, or turn on
execution.

## Read-only acceptance evidence

On 2026-10-26, without credentials, the official token endpoint returned HTTP
200 with 208 tokens across 37 current chain codes. That live response exposed
`qtc` and `abs` codes not present in the earlier rendered enum, so the adapter
was updated to accept those provider-observed values and regression-tested.
The bounded adapter then obtained and verified a real `dry: true` wNEAR -> USDC
quote: the provider signature passed, the Base58 quote hash was 44 characters,
and no deposit address was returned. This proves only read/dry-quote
connectivity at that moment, not route longevity, liquidity, settlement, or
execution readiness.

The public NEAR AI model catalog also returned HTTP 200 (61 models reported,
15 marked ready at the time of the check), and NEAR mainnet RPC `status`
returned HTTP 200 with `syncing: false`. No model completion, wallet action,
transaction, or paid operation was performed.
