# Harbor architecture and ownership boundaries

Harbor is the separately deployable policy and execution service behind Pilot; this document does not authorize deployment or claim live acceptance.

## Current source map

| Boundary | Current source | Ownership rule |
| --- | --- | --- |
| Transport and composition | `src/server.ts` | Authentication, runtime-profile selection, MCP/REST/webhook routing, and feature wiring. |
| Contracts | `src/contracts.ts` | Harbor is the byte source of truth; Pilot consumes an exact, hash-pinned copy. |
| Operation catalog | `src/catalog/registry.ts`, `src/ops/`, `catalog/` | Authored inputs produce ignored `src/ops/index.gen.ts` and `catalog/manifest.json`. |
| Policy and delegation | `src/exec/policy.ts`, `src/exec/delegation.ts` | Fail closed. Permission, signing, quota, and approval semantics are security boundaries. |
| Transaction lifecycle | `src/exec/`, especially `src/ops/tx-exec.ts` | Construction, persistence, sequence leasing, approval, relay, submission, and reconciliation remain behaviorally coupled. |
| Sandbox execution | `src/executor/` | Dynamic execution is exposed only through guarded providers and profile allowlists. |
| Integrations | `src/adapters/`, `src/aws/`, `src/quicknode/`, `src/strategy/` | External capability adapters; tests and stand-ins are not live acceptance. |
| Persistence history | `migrations*` | Preserve every filename and byte. Duplicate numeric prefixes are existing history, not cleanup targets. |
| Local stand-ins | `tools/aws-local/`, `tools/qn-local/` | Deterministic mock/offline support only. |

Static analysis found no Harbor TypeScript import cycle. Pure transaction fact collection now lives in `src/exec/transaction/facts.ts` behind the unchanged `tx-exec.ts` facade. The remaining organization risks are size and hidden profile coupling: `src/ops/tx-exec.ts`, `src/ops/tx.ts`, `src/exec/x402-pay.ts`, `src/exec/store.ts`, `src/exec/ap4m-store.ts`, and `src/exec/build.ts` should not be split further without focused characterization tests and coordinated review.

## Target tree (partially applied)

```text
src/
  app/{server,auth,env,routes}/
  contracts/
  catalog/
  transport/{mcp,rest,sandbox}/
  ledger/{builders,delegation,execution,policy,store,watcher}/
  features/{x402,ap4m,strategy,quicknode,aws}/
  guard/
catalog/
migrations/
migration-profiles/
tools/standins/
scripts/{generate,verify,local,provision}/
docs/{architecture,reconstruction,operations,runbooks}/
```

This target preserves Harbor as a service and keeps current public operation and contract paths behind compatibility facades. Moving contracts, migration files, policy/signing code, profile markers, stores, `server.ts`, or `tx-exec.ts` is a high-risk later change.

## Configuration and licensing boundaries

Protected Mac paths and profile directories encode canonical-path, ownership, permission, and no-symlink checks. They are external runtime capabilities, not contributor bootstrap inputs. A future portability change must preserve those fail-closed checks.

`wrangler.jsonc` must contain an operator-reviewed destination Worker/D1 identity before use.

No project-level license is currently present. That uncertainty is intentional here: license, copyright, and redistribution decisions require Austin's explicit decision. Existing dependency credits and bundled third-party licenses are factual attribution, not a project license grant.

## Additive declarative-strategy boundary

`declarative_strategy_v1` is an additive feature boundary under
`src/strategy/`; its supported grammar and evidence limits are documented in
[`docs/autonomous-declarative-strategies.md`](../autonomous-declarative-strategies.md).
The compiler/interpreter is pure and accepts only registered, finite plan
primitives. The store and runner continue to own immutable mandate versions,
atomic quota reservation, idempotent decisions, scheduler fencing, and
reconciliation. The execution adapter continues to route every action through
the existing `tx.swap` and `tx.execute` policy boundary.

This slice does not generalize the sandbox, operation catalog, transaction
builders, signing, or network profile. Agent output ends at a validated
proposal. It never becomes executable code or authority. The authoritative
account-wide sequence coordinator remains shared across manual, strategy, x402,
and AP4M sources; no feature-local sequence allocator is permitted.

The existing `xrp_issued_rebalancer_v1` is a compatibility contract. It remains
interpreted by its original engine. A declarative plan is a new mandate kind
and version, not an in-place conversion. Any future primitive must be added by
reviewed registration plus paired contract and fixture changes.
