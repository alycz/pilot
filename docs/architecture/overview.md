# Pilot architecture and ownership boundaries

Pilot is the product and user-experience application. Harbor remains a separately deployable policy and execution service; this document does not authorize deployment, signing, funding, or live transactions.

## Current source map

| Boundary | Current source | Ownership rule |
| --- | --- | --- |
| Product application | `apps/web/` | UI, route handlers, auth/model gates, onboarding, portfolio/map, chat and memory. |
| Shared Harbor contract | `packages/contracts/` | Exact copy of Harbor `src/contracts.ts`, bound to an immutable Harbor commit and SHA-256. |
| Harbor transport | `packages/harbor-client/` | Typed REST client and mock implementation. Its 70-operation surface is manually maintained against Harbor's 88 operations. |
| Intent and agent composition | `packages/intents/`, `packages/agent/` | Intent parsing and orchestration above contracts/client. |
| Wallet and vault | `packages/wallet/`, `packages/vault/` | Signing/device/key boundaries; keep feature defaults off and semantics unchanged. |
| Offline browser evidence | `e2e/`, Playwright fixture configuration | Credential-scrubbed, loopback-only fixture evidence; not wallet or ledger acceptance. |
| Auxiliary integrations | `x402/`, `third_party/`, `tools/ledger-sim/`, `scripts/` | Mock merchants, vendored verifier/provenance, Ledger fixtures, and bounded tooling. |

The workspace package graph is acyclic. The former wallet type-only cycle through `index.ts` and the Ledger modules is removed: shared declarations now live in `packages/wallet/src/types.ts` and remain re-exported from the public root. Large onboarding, RLUSD acquisition, chat, retention, and Harbor-client files still require characterization before decomposition.

## Target tree (partially applied)

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
docs/{architecture,reconstruction,operations}/
third_party/
tools/ledger-sim/
```

Compatibility exports must remain at current module paths. Auth, quota, wallet/signing, Harbor policy contracts, and default-off feature behavior are not organization-only changes.

## Coupling and provenance

The contract bytes currently hash to `898eea530ce49b020e4c10419ff2fb8ca3505d5de01b5981569ea18a6535b3e6`. Equal bytes do not prove equal runtime semantics: Harbor uses Zod 4.6.7 while `@pilot/contracts` uses Zod 3.25.76. Alignment needs its own fixture-backed compatibility review.

Protected run-kit and isolated-profile paths encode security boundaries. They remain external capabilities rather than generic setup instructions. Machine-specific paths, wallet sessions, and live account state are never reconstruction inputs.

No project-level license is currently present. No license, ownership, or copyright assertion is made here. Austin/legal must decide project redistribution terms. The vendored Verifiable Intent license/provenance and Geist font OFL are factual third-party attribution and must remain with those assets. The Ledger ELF is checksum-bound, but its exact upstream rebuild inputs and adjacent redistribution notices remain unresolved.

## Additive declarative-strategy boundary

Pilot's declarative autonomous section is a product layer over Harbor's typed
plan contract; see
[`docs/autonomous-declarative-strategies.md`](../autonomous-declarative-strategies.md).
The model/tool path may populate a proposal only. Contract validation, canonical
digest construction, paper evaluation, owner proof, execution policy, quota,
sequence ownership, and reconciliation remain separate boundaries.

The authenticated editor/review surface remains distinct from the signed-out
illustrative demo. Signed-out rendering has no wallet, authentication, Harbor
mutation, or persistent authority path. Authenticated pending operations are
scoped to the exact wallet account and stable request identity so reload or
account switching cannot apply an unknown outcome to another owner.

The shared contract remains Harbor-owned and byte-pinned in Pilot. The plan
grammar, digest semantics, client inventory, mock fixtures, and browser fixtures
must change as one paired slice. UI-local types may shape presentation but must
not redefine or broaden executable plan primitives.
