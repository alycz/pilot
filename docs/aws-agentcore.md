# AWS AgentCore integration

Pilot treats Amazon Bedrock AgentCore as an optional, untrusted research worker.
It is not a model-provider alias, policy engine, wallet, signer, payment service,
or substitute for Harbor.

The implemented server-side flow is:

1. Pilot derives tenant, wallet, network, and request scope on the server.
2. An explicit `operation: "agentcore_research"` request creates a dedicated
   model run exposing only the `agentcore_research` tool.
3. The runtime contract permits one exact AWS-visible Gateway/MCP tool name in
   `${target_name}___${tool_name}` form.
4. Pilot strictly validates the structured advisory response.
5. Any later transaction still uses `propose_intent` and Harbor's existing
   simulation, policy, consent, signing, submission, and reconciliation path.
   Transaction/payment/memory tools are absent from the AgentCore model run;
   research output cannot spend the same wallet proof in either call order.

`AGENTCORE_MODE=off` is the default. `standin` runs only against an explicit
loopback origin and labels every result synthetic. `aws` uses the official
`@aws-sdk/client-bedrock-agentcore` `InvokeAgentRuntimeCommand` using IAM/SigV4
with SDK retries disabled. It requires an exact Runtime ARN, qualifier, Region,
Gateway URL, and deployed Gateway-visible tool name. The Runtime request and
response both bind digests of that Gateway configuration, the server-derived
scope, and the read request. OAuth Runtime invocation is not implemented.
The current Gateway HTTP adapter is explicitly `CUSTOM_JWT` bearer mode; an
AWS-IAM Gateway requires a separately implemented SigV4 transport and must not
be selected during setup for this adapter.
The MCP protocol is pinned to `2025-11-25`; it is never negotiated implicitly.

The local stand-in proves the Pilot Runtime payload, the shared deployable
Runtime handler, Runtime-to-Gateway MCP framing, exact tool allowlist, output
validation, byte limits, timeouts, and synthetic provenance. It does not prove AWS IAM/JWT enforcement, deployed
Runtime or Gateway behavior, OAuth grants, AWS isolation, CloudWatch telemetry,
or live target credentials.

Account-time activation still requires a deployed Runtime version/endpoint,
a separate MCP Gateway and read-only target, least-privilege IAM roles, inbound
authentication, and any Identity credential provider/grants. Gateway-managed
credential injection should keep target tokens outside model/tool arguments.
After June 30, 2026, the Runtime must set
`metadataConfiguration.requireMMDSV2=true`. The execution role must remain no
more privileged than the callers because runtime code can access its role
credentials. No provisioning code or control-plane SDK is included here.
