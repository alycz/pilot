# Workflow lesson proposals

`@pilot/agent/workflow-lessons` provides a small, provider-neutral review boundary
for learning how a user prefers trading information to be presented. It is not a
training system and cannot change trading policy, risk, wallets, signing,
allowlists, orders, transactions, or execution behavior.

The intended server-side flow is:

1. Derive `WorkflowLessonScope` from the authenticated tenant, principal, and
   profile. Never accept those identifiers from browser state.
2. Convert explicit user feedback and a separately validated experience into the
   strict evidence-reference schemas. `source_ref` is a SHA-256 reference to
   evidence retained and access-controlled by the owning service; this package
   does not fetch or validate the referenced source.
3. Call `createWorkflowLessonProposal` or `refineWorkflowLessonProposal`. The
   returned immutable artifact is `pending_user_review` and `not_written`.
4. Show the exact proposal to the user. Only an explicit user decision may be
   passed to `reviewWorkflowLessonProposal`.
5. Treat `approved_for_persistence` as permission for a separate persistence
   layer to attempt an optimistic, revision-checked write. This package performs
   no write and approval is not durable promotion.

Safe lesson targets are deliberately limited to response detail, evidence
layout, approval explanation, comparison emphasis, and research risk posture.
Research risk posture changes only the ordering and explanation of research
(`capital_preservation_first`, `balanced`, or `opportunity_first`); it never
changes an intent, amount, route, policy, approval, signing, or execution.
Unknown fields fail closed. Integrators must re-check scope, proposal identity,
evidence ownership, and `base_durable_revision` at the durable write boundary.

An explicit research-risk-posture preference may be proposed for a new user
without prior transaction evidence. It still requires exact user feedback and
explicit review. Other workflow lessons, including lessons tied to trading
experience, require separately verified experience evidence; a model claim is
not evidence.

This component is inspired by iterative propose/review/refine workflows. It is
not a Google Harness² integration. It also does not require or demonstrate a
live Hermes runtime.

## Pilot integration

Pilot's optional structured-personalization feature wires this boundary to a
private local store. Every candidate requires exact, durable user feedback that
maps to a safe target. Experience-derived lessons additionally require Pilot to
resolve a validated-transaction application record inside the same
authenticated owner/network vault scope. That stored record proves only that
Pilot journaled a validated experience; it is not a fresh ledger attestation.
Estimated slippage, unavailable fill data, profitability, and rewards are never
lesson evidence.

The Memory view performs the explicit accept/reject/correct/forget action. The
server derives scope again, reconstructs the exact stored proposal, and
revalidates its trade reference before acceptance or correction. Accepted
lessons are injected into later chats as bounded untrusted presentation context;
the current request overrides them, and a per-request personalization opt-out
removes them. Forget removes the managed lesson and evidence references, leaving
only a content-free tombstone.

This integration is gated with `PILOT_STRUCTURED_PREFERENCES=1`; omission or `0`
keeps legacy behavior. It does not invoke `HermesProposalProvider` or any remote
proposal transport.
