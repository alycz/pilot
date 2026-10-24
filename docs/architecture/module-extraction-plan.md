# Pilot module extraction plan

The reproducibility base changes no product, auth, quota, wallet, signing, or memory behavior. The stacked source-organization PR completes only the wallet type boundary below. All other boundaries remain proposed for parent review.

## 1. Onboarding flow

Keep `components/onboarding/onboarding-flow.tsx` as the public composition facade while extracting:

1. Pure state/types and reducer transitions.
2. Wallet-provider availability, connection, proof, and restoration adapters.
3. Model-access and quota-readiness adapters.
4. Delegation draft/preflight/recovery state.
5. Presentational step components under `components/onboarding/steps/`.

Preserve DOM labels/test ids, wallet-first ordering, exact fail-closed messages, no-prompt availability checks, and the boundary between authentication and trading authority. Move one concern at a time, running onboarding unit and fixture browser coverage after each move.

## 2. RLUSD acquisition handler

Keep the current route/handler export while extracting pure validation and envelope parsing, durable state/lock generation management, wallet proof consumption, Harbor submit/reconcile, and response serialization. Lease fencing, compaction, callback ordering, exact recovery state, and idempotency remain the compatibility contract. The existing 162-test route suite is the minimum gate.

## 3. Harbor client contract

Keep `packages/harbor-client/src/types.ts` as a re-export facade. First add a pinned compatibility inventory, then separate operation-name groups, argument schemas, result schemas, and common envelopes. Every typed operation must remain a subset of the pinned Harbor catalog; no generated client replaces the manual client until transport-schema generation is specified and fixture-tested.

## 4. Chat composition

Keep `app/api/chat/handler.ts` as the route-facing facade. Extract model selection/quota reservation, Harbor tool wiring, memory/lesson proposal orchestration, and stream response shaping behind current interfaces. Reservation uncertainty, consent epochs, tool exposure, and error mapping cannot change in an organization PR.

## 5. Hermes retention

Separate journal codec, file/lock primitives, retention state machine, and sweeper scheduling from `lib/hermes-retention.ts`, with the current service API retained. Durable tombstones, ownership/fencing, symlink rejection, bounded retries, cancellation, and readiness must retain their exact tests.

## 6. Wallet type cycle — implemented

Shared type declarations and `PilotWalletError` now live in `packages/wallet/src/types.ts`, with the same public API re-exported from `index.ts`. Ledger modules import the leaf module, removing the type-only cycle while preserving runtime class identity. Ledger transport, device, and signing bodies remain untouched; package, public-boundary, and bundle-boundary tests cover the change.

## Sequencing

The safest order is compatibility inventory, wallet type-only extraction, Harbor-client facade split, onboarding state/presentation split, then the RLUSD/chat/Hermes stateful modules. The last three are independent high-risk efforts and should not share a PR.
