# Pilot architecture and ownership boundaries

Pilot is the product and user-experience application. Harbor remains a separately deployable policy and execution service under `services/harbor/`. This document does not authorize deployment, signing, funding, or live transactions.

## Current source map

| Boundary | Current source | Ownership rule |
| --- | --- | --- |
| Product application | `apps/web/` | UI, route handlers, auth/model gates, onboarding, portfolio/map, chat and memory. |
| Shared execution contract | `packages/contracts/` | Exact copy of `services/harbor/src/contracts.ts`, bound to `packages/contracts/CONTRACT_HASH`. |
| Harbor transport | `packages/harbor-client/` | Typed REST client and mock implementation. Its 70-operation surface is manually maintained against Harbor's 88 operations. |
| Intent and agent composition | `packages/intents/`, `packages/agent/` | Intent parsing and orchestration above contracts/client. |
| Wallet and vault | `packages/wallet/`, `packages/vault/` | Signing/device/key boundaries; keep feature defaults off and semantics unchanged. |
| Offline browser evidence | `e2e/`, Playwright fixture configuration | Credential-scrubbed, loopback-only fixture evidence; not wallet or ledger acceptance. |
| Auxiliary integrations | `apps/web/api/x402/`, `services/ap4m-merchants/validator/_vendor/`, `tools/ledger-sim/`, `scripts/` | Mock merchants, vendored verifier/provenance, Ledger fixtures, and bounded tooling. |

The workspace package graph is acyclic. The wallet source has a type-only cycle through `index.ts`, `ledger/facade.ts`, `ledger/device-manager.ts`, and `ledger/xrp.ts`; moving shared wallet types is a later reviewed change. Large onboarding, RLUSD acquisition, chat, retention, and Harbor-client files also require characterization before decomposition.

## Proposed target tree (not applied)

```text
apps/web/
  app/
  components/onboarding/{flow,state,steps}/
  lib/hermes/{retention,bridge,runtime,egress}/
packages/
  contracts/
  harbor-client/{compat,src/operations,src/schemas,src/results}/
  intents/
  agent/
  wallet/src/{types,ledger}/
  vault/
scripts/{contracts,repro}/
docs/{architecture,operations}/
third_party/
tools/ledger-sim/
```

Compatibility exports must remain at current module paths. Auth, quota, wallet/signing, Harbor policy contracts, and default-off feature behavior are not organization-only changes.

## Coupling and provenance

The contract bytes currently hash to `898eea530ce49b020e4c10419ff2fb8ca3505d5de01b5981569ea18a6535b3e6`. Equal bytes do not prove equal runtime semantics: Harbor uses Zod 4.6.7 while `@pilot/contracts` uses Zod 3.25.76. Alignment needs its own fixture-backed compatibility review.

Private runtime roots and isolated-profile paths encode security boundaries. They remain explicit external capabilities rather than generic setup instructions. Machine-specific paths, wallet sessions, and live account state are never tracked application inputs.

The destination root license remains in force. The vendored Verifiable Intent license/provenance and Geist font OFL are factual third-party notices and must remain with those assets. The Ledger ELF remains checksum-bound; its upstream rebuild inputs and any adjacent redistribution notices must be reviewed before redistribution.
