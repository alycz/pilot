# Ledger trust-flow operator handoff

This handoff is configuration guidance only. It does not authorize account
creation, funding, deployment, credential issuance, permissions, or any live
transaction. The branch remains local and all live gates remain off.

## Required operator-supplied resources

- One existing XRPL **Testnet** owner account that matches the selected Ledger
  account index. For Speculos, use only an existing instance loaded with its
  documented public default test seed; never enter or persist an owner seed.
- Existing loopback Pilot and Harbor processes, plus Harbor's local D1 binding.
- One named Harbor principal and a matching high-entropy bearer supplied to
  Pilot and Harbor. `local-dev` is intentionally rejected.
- An existing XRP app whose version is read through Ledger app config. The new
  issued-asset binder recognizes only the pinned `2.8.2` display profile.
- For the current x402 and capability demonstrations, only the built-in local
  merchant, simulated settlement, mock secret store, and fixed mock adapter.
  No production secret or credential should be created.

## Configuration placeholders

Pilot server environment:

```dotenv
PILOT_DEPLOYMENT_PROFILE=local-wallet
EXEC_NETWORK=testnet
HARBOR_URL=http://127.0.0.1:8791
HARBOR_API_KEY=<named-principal>:<server-only-random-bearer>
HARBOR_MOCK=1
HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED=true
HARBOR_LOCAL_WORK_AGREEMENT_ENABLED=true
PILOT_WORK_AGREEMENT_FIXTURE=1
LEDGER_MODE=<webhid-or-virtual>
LEDGER_SPECULOS_URL=<blank-for-webhid-or-http://127.0.0.1:5000>
LEDGER_DEFAULT_ACCOUNT_INDEX=<existing-account-index>
```

Matching Harbor environment:

```dotenv
HARBOR_API_KEYS=<same-named-principal>:<same-server-only-random-bearer>
HARBOR_LOCAL_DEV=true
HARBOR_MOCK=1
HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED=true
HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED=true
HARBOR_LOCAL_WORK_AGREEMENT_ENABLED=true
EXEC_NETWORK=testnet
MAINNET_EXECUTION=false
HARBOR_SOURCE_TAG=<reviewed-uint32-fixture-tag>
```

These are placeholders, not values. Keep credentials in an owner-controlled
secret file outside the repository with owner-only permissions, or inject them
through the approved local secret manager. Do not paste them into chat, commit
them, expose them through `NEXT_PUBLIC_*`, or place them in browser storage.
The isolated launchers, when used, must continue reading only their fixed
external credential/capability files.

## Local verification

1. Confirm `EXEC_NETWORK=testnet`, `MAINNET_EXECUTION=false`, loopback origins,
   and the exact named principal before starting anything.
2. Run `pnpm typecheck` and the focused wallet, Harbor, and web trust-flow tests.
3. Run `pnpm --filter web build`; confirm `/demo/ledger-x402`,
   `/demo/ledger-capabilities`, and `/agreements` are generated.
4. With an already available local Speculos instance, read the XRP app config
   and account address before enabling UI actions. The issued-asset binder must
   reject an unknown app version or any network other than `xrpl:1` Testnet.
5. Exercise only fixture requests. Receipts must say
   `local-mock-simulated-settlement`; a valid signature proves signing-key
   control only and does not prove a physical Ledger.
6. For durable escrow tests, use only the five fixed `workAgreement.*`
   operations. Confirm submit first becomes `unknown`, restart recovery performs
   lookup without redispatch, and the response retains `simulation=true`,
   `network_requests_made=0`, and no physical-device claim.

The current environment has no usable Speculos listener, so step 4 remains
unrun here. Do not change ports, permissions, container state, seed handling,
or SSH configuration to force it.

## Live verification

No live verification is currently authorized or implemented. Before any later
live Testnet check, an operator must separately approve the exact account,
asset identity, issuer, payee, amount, fee, ledger window, funding source,
service endpoints, and cost ceiling. Start with read-only network-ID, account,
app-version, and balance checks. Keep submission disabled until the resulting
unsigned transaction passes the same local binder and the user reviews it on
device. Mainnet execution is unsupported and must remain blocked.

## Default-off gates

- `HARBOR_LOCAL_X402_OWNER_REVIEW_ENABLED=false`
- `HARBOR_LOCAL_CAPABILITY_RUNTIME_ENABLED=false`
- `HARBOR_LOCAL_WORK_AGREEMENT_ENABLED=false`
- `PILOT_WORK_AGREEMENT_FIXTURE=0`
- `TEST_SIGNER=0` and `NEXT_PUBLIC_DEV_SIGNER=0`
- `PILOT_E2E_ALLOW_AUTHENTICATED_LIVE=0`
- `P_LIVE_HARBOR_FOK_DEPLOYED=0`
- `P_LIVE_HARBOR_OWNER_APPROVAL_DEPLOYED=0`
- `P_LIVE_HARBOR_EXECUTION_V2=0`
- `MAINNET_EXECUTION=false`

## Costs and changes requiring separate approval

- Any hosted deployment, domain, Cloudflare Worker/D1 resource, AWS AgentCore,
  Bedrock, KMS, QuickNode, facilitator, paid model, or other metered service.
- Any new account, credential, grant, secret, database, cloud resource, or
  change to filesystem, container, USB, browser, or network permissions.
- Any faucet request, Testnet funding, trust line, RLUSD acquisition, signed
  transaction, relay, or settlement check, even when the asset has no monetary
  value. Mainnet and real-fund activity remain prohibited.

## Genuine missing code or evidence

- The issued-asset Ledger binder is a tested pure boundary only. Harbor RLUSD
  adapter integration, browser state/UI, route wiring, and device app-config
  plumbing are not yet merged. Its versioned semantic approval digest must be
  adopted atomically by the issued merchant/Harbor path because the signed
  `InvoiceID` equals that digest; mixing it with the older raw-invoice hash
  convention fails closed. Harbor's deterministic issued fixture implements
  the new contract, but the older Python merchant parser and
  `PAYMENT-SIGNATURE` payload do not; cross-process compatibility remains
  blocked until both migrate together without fallback. Native-XRP and AP4M
  invoice contracts are unchanged.
- No higher `SendMax` is supported. `Amount` and `SendMax` must be identical;
  transfer-fee or slippage headroom requires a separately reviewed policy.
- Durable authenticated local escrow submission/recovery is implemented, but
  `/agreements` still shows the separate invalid recorded fixture. The durable
  controller/view mount waits for the post-PR13 feature presentation pass.
- The escrow relay and settlement source are deterministic local stand-ins.
  No live XRPL adapter, Testnet submission, Speculos run, or physical-device
  acceptance evidence exists.
- Production capability secret stores/adapters and live x402 merchant,
  settlement, and resource adapters are absent.
- Ambiguous capability preparation remains safely locked because Harbor has no
  lookup/idempotency endpoint for a committed-but-lost reference.
- New-flow Speculos and physical-device conformance are unrun. The app's public
  documentation supports issued assets, but physical-device provenance cannot
  be inferred from a signature or WebHID transport.
