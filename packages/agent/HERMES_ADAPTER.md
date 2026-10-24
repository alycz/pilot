# Restricted Hermes proposal adapter

This package contains an optional, server-only proposal adapter for the Hermes
OpenAI-compatible API. It is disabled unless an enabled configuration is passed
explicitly. No browser wiring or runtime enablement is included.

The adapter deliberately exposes only two validated result kinds:

- bounded read-only summaries with evidence and caveats; and
- bounded declarative procedure proposals for later offline review.

It has no signing, transaction, Harbor credential, shell, arbitrary tool, MCP,
promotion, or policy-mutation interface. The request chooses neither endpoint,
profile, provider, model, tools, nor memory scope.

"Read-only" describes the validated result and the absence of Pilot, Harbor, or
ledger mutations. An enabled call is still a network/model request, and Hermes
may persist admissions, idempotency records, sessions, conversation history, or
profile memory. The adapter therefore does not claim to be side-effect-free.

## Required deployment boundary

Hermes documents that its API server has access to the agent's full toolset and
that a frontend system prompt is additive: it does not remove terminal, file,
memory, skill, or MCP capabilities. Consequently, prompt instructions and an
empty OpenAI `tools` list are not treated as a security boundary here.

Before each proposal turn, the adapter reads the named profile's authenticated
`/v1/toolsets` endpoint and refuses the turn unless it reports no concrete
tools. The configured profile is also bound to one exact server-derived Pilot
scope. A separately provisioned Hermes profile and API key are required for
each such scope because Hermes' on-disk `MEMORY.md` and `USER.md` are scoped to
the profile home, not automatically isolated by a tenant header. The opaque
`X-Hermes-Session-Key` adds stable per-channel scoping inside that dedicated
profile; it does not replace profile isolation.

Configuration belongs in server-only environment handling and should provide:

- `enabled: true` only after the restricted profile has been reviewed;
- a fixed HTTPS origin, or a fixed loopback HTTP origin for local use;
- a non-default named profile;
- the profile binding derived from authenticated server scope;
- that profile's Hermes API key; and
- a fixed model name and bounded timeout/response limits.

The dedicated profile's resolved configuration must be operationally immutable
for the duration of use: no concurrent toolset, skill, MCP, memory-provider, or
profile configuration changes are permitted. This is required because the
documented toolset discovery and proposal request are separate HTTP operations.

Never reuse a Harbor API key, wallet secret, signing key, or another Hermes
profile's key. Never expose this configuration to browser code.

## Readiness status

The checked-in tests use an injected mock HTTP transport. They cover request and
response validation, scope/profile binding, capability attestation, redirect
refusal, cancellation, deadlines, size limits, and error sanitization. They do
not prove an upstream Hermes profile is actually tool-free or tenant-isolated.

There is also an unavoidable check/use interval between `/v1/toolsets` and the
proposal turn in the currently documented API. The adapter must remain disabled
and unwired until real acceptance provisions and reviews an immutable dedicated
profile, confirms its resolved API-server toolsets are empty, and passes a
separate end-to-end test against that exact profile. This repository does not
perform those actions.

Official references:

- [Hermes API Server](https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server)
- [Hermes MCP](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp/)
- [Hermes Persistent Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/)
