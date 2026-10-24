# Pilot isolated x402 profile

Status: offline source and mock-transport evidence only. No live merchant,
Harbor, wallet, payment, or Testnet acceptance was exercised.

Pilot keeps its accepted isolated owner/session profile on
`http://127.0.0.2:3003`. Ordinary REST operations and MCP remain pinned to the
isolated trading Harbor at `http://127.0.0.2:8791`. Only the exact `x402.pay`
operation may use `http://127.0.0.2:8792`, through a second server-side named
credential. No x402 credential is exposed to browser code, request bodies, or
response headers.

The legacy `.1` Pilot/Harbor x402 route is unchanged. Hosted mode, mainnet,
alternate loopback targets, trailing paths, cross-profile x402 variables,
missing credentials, and reused trading/x402 principals fail closed.

## Separate capability materialization

No credential was created or read. The existing isolated Pilot file remains
unchanged at:

`${PILOT_PRIVATE_SECRETS_ROOT:?set PILOT_PRIVATE_SECRETS_ROOT}/pilot-isolated-v1.env.local`

It continues to contain only the existing isolated trading named credential and
Pilot session secret. The isolated launcher reads those values from that file,
then reads exactly one additional server-side capability from:

`${PILOT_PRIVATE_SECRETS_ROOT:?set PILOT_PRIVATE_SECRETS_ROOT}/pilot-isolated-x402-capability-v1.env.local`

The checked-in template shows its single allowed entry. The Harbor isolated
provisioner can publish that new file directly with owner-only mode and
exclusive creation; it never reads, copies, replaces, or rewrites the existing
Pilot file. The launcher rejects symlinks, non-private inputs, malformed or
additional entries, and reuse of the trading principal.

Do not place these values in generic dotenv files or browser-visible variables.
Actually materializing the capability and provisioning its matching Harbor
credential require later explicit approval.

The merchant profile preflight accepts both the unchanged legacy profile and
the exact isolated filename/marker set. The isolated check rejects missing or
mixed trading markers and reads only the checked-in public JSON configuration,
never a secrets file.

## Future reviewed run sequence

Only after the merchant, Harbor isolated provisioner, payer, and Pilot
credential file are independently reviewed and explicitly approved:

```text
# terminal A: fixed merchant fixture or reviewed real merchant
# use its own runbook; it must bind only 127.0.0.1:8000

# terminal B: dedicated Harbor x402 process
npm run dev:local:x402:isolated:v1

# terminal C: Pilot, from the integrated Pilot checkout
pnpm dev:isolated:x402
```

The runtime operator must verify the merchant price is at most 100,000 drops,
the Harbor policy permits no more than that per call, payer fee is at most 100
drops, and all three profiles have distinct credentials/state. Stop the Pilot,
Harbor `.2:8792`, and merchant listeners after the test. A fixture-delivered
response is not evidence of a real payment.
