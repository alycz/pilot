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

The local stand-in proves the Pilot Runtime payload, the shared Runtime handler,
Runtime-to-Gateway MCP framing, exact tool allowlist, output validation, byte
limits, timeouts, and synthetic provenance. It does not prove AWS IAM/JWT
enforcement, deployed Runtime or Gateway behavior, OAuth grants, AWS isolation,
CloudWatch telemetry, or live target credentials.

The production container seam is implemented: it is designed to bind
`0.0.0.0:8080`, serve exact `/ping` and `/invocations` routes, require one bounded
platform-provided `WorkloadAccessToken`, exchange it only through
`GetResourceOauth2Token`, verify the resulting JWT locally, and then perform
the pinned MCP initialize/session/initialized/tool-call lifecycle. The ARM64
non-root image recipe is `packages/agentcore/Dockerfile.runtime`. Runtime startup
currently fails before binding unless a durable replay adapter is injected; the
checked-in DynamoDB seam does not yet compose an official AWS SDK transport.
The image therefore has not been built, pushed, or run on AgentCore and is not
currently an AWS-bootable artifact.

Wallet identity remains inside the Pilot-to-Runtime digest boundary. The
Runtime-to-Gateway-to-Lambda request contains only `requestId`, an opaque
`scopeDigest`, and the exact empty `context` object. Public XRP/RLUSD Testnet
spot selectors come only from fixed Runtime/Lambda configuration. The external
request contains no research prompt, caller-selected selector, XRPL address,
wallet tenant, network, personalization, token, key, signing, or payment data.

Account-time activation still requires a deployed Runtime version/endpoint,
a separate MCP Gateway and read-only target, least-privilege IAM roles, inbound
authentication, and any Identity credential provider/grants. Gateway-managed
credential injection should keep target tokens outside model/tool arguments.
After June 30, 2026, the Runtime must set
`metadataConfiguration.requireMMDSV2=true`. The execution role must remain no
more privileged than the callers because runtime code can access its role
credentials. Inert account-neutral templates and strict input schemas live in
`infra/agentcore`; they are review artifacts, not deployment evidence and have
not been applied.

## Operator handoff

Keep `AGENTCORE_MODE=off` until all live acceptance checks below pass. Copy the
non-secret names and identifiers from `config/pilot-agentcore.env.template` into
the deployment's managed configuration. Do not commit a populated env file.

Required AWS-side resources:

- one AgentCore Runtime version/endpoint in `us-east-1`, with an execution role
  limited to the one research path and
  `metadataConfiguration.requireMMDSV2=true`;
- one separately authenticated AgentCore MCP Gateway;
- one read-only Gateway target whose visible name exactly matches
  `${target_name}___${tool_name}` and whose output matches the strict market
  context contract;
- an inbound `CUSTOM_JWT` configuration whose issuer/discovery URL and audience
  let the Gateway validate one short-lived workload JWT, with exact subject and
  deployment-tenant claim name/value matching the Runtime verifier; and
- an AgentCore Identity OAuth2 credential provider that the current Runtime
  uses to exchange its workload token for the short-lived `CUSTOM_JWT` bearer
  token required by the Gateway; and
- separately, a target credential provider only if a future outbound target
  requires one. The current public Lambda target does not. Target credentials
  never belong in Pilot or model/tool arguments.

The Gateway Lambda target now has a concrete ESM entrypoint and bounded public-
market source. It reads only the fixed XRP/RLUSD ask-side book from the exact
public XRPL Testnet JSON-RPC endpoint. It first pins a validated ledger, then
binds `book_offers` to that ledger hash and index. It validates the configured
RLUSD issuer checksum, rechecks ledger freshness after the book response,
rejects redirects and oversized or malformed responses, and sends no
authorization header. It signs, submits, simulates, and stores nothing. The
returned offer count is a capped observation, not an executable price or full-
depth guarantee.

The internal Pilot request must specify XRP/RLUSD and current spot context.
Runtime validates that contract before Gateway dispatch and sends an empty
external `context`; the Lambda injects its fixed configured assets. Gateway,
Lambda, and source therefore receive no caller-selected pair, timeframe, venue,
prompt, wallet identity, or private personalization.

Required non-secret configuration:

- `AWS_REGION=us-east-1`;
- `AGENTCORE_RUNTIME_ARN` and `AGENTCORE_RUNTIME_QUALIFIER`;
- the exact `/mcp` `AGENTCORE_GATEWAY_URL`;
- the exact target-prefixed `AGENTCORE_GATEWAY_TOOL_NAME`; and
- the fixed auth/protocol settings in the template.

The Lambda separately requires the exact Gateway and target IDs, target name,
verified public Testnet RLUSD issuer, and fixed public endpoint shown in
`config/pilot-agentcore.env.template`. Because a target needs the Lambda ARN
while strict Lambda validation needs the generated target ID, activation is
two-phase: create the fail-closed function, create the target, then update the
function with the returned target ID and publish or alias the accepted version.
Do not call the function ready between those steps.

Run `pnpm --filter @pilot/agentcore verify:lambda` to rebuild the deterministic
Node 22 ESM bundle under `packages/agentcore/dist/lambda`, emit its byte count
and SHA-256 manifest, preserve legal comments, generate the reviewed
`THIRD_PARTY_NOTICES.txt`, and invoke the emitted handler against offline
ledger/book fixtures. This creates no zip or AWS resource. An approved operator
must inspect the bundle, manifest, and notices before creating a versioned
deployment zip and must verify that the zip root contains `lambda-entry.mjs`,
`manifest.json`, and `THIRD_PARTY_NOTICES.txt`.

Use AWS SSO, workload identity, or an approved short-lived assumed role for the
Node server's normal AWS SDK credential chain. Give the Pilot caller role only
`bedrock-agentcore:InvokeAgentRuntime` on the exact Runtime/endpoint. Keep the
Runtime execution role, Gateway execution role, and resource-management role
separate. Enter target credentials only in the approved AgentCore
Identity/Secrets workflow under the operator's account.
Do not put AWS access keys, JWTs, OAuth client secrets, target API keys, or token
values in the repository, an env template, chat, logs, model context, tool
arguments, or receipts.

Important identity gate: the current Pilot caller invokes Runtime with IAM/
SigV4 only. AWS documents automatic `WorkloadAccessToken` delivery for an
inbound identity flow, but that delivery has not been demonstrated for this
exact IAM-only path. The Runtime therefore fails closed when the token is
absent. Before activation, choose and verify an approved inbound identity path
(for example, a reviewed JWT-authorized Runtime call), or prove the account's
supported IAM behavior. Do not add a static token or derive an opaque delegated
user ID from a browser-supplied wallet field as a shortcut.

The configured JWT issuer and same-origin JWKS URL are security boundaries.
Code rejects literal IPs, localhost, redirects, and cross-origin JWKS, but DNS
resolution and egress policy are deployment controls. Before activation, pin an
approved issuer, constrain Runtime DNS/egress, and verify discovery and JWKS
resolution inside the destination account. Local URL validation alone is not
SSRF or DNS-rebinding proof.

Local verification uses `AGENTCORE_MODE=standin` with the loopback server from
the integration test and must retain the synthetic provenance label. Live
acceptance must separately demonstrate Runtime IAM enforcement, Gateway JWT
validation, exact-tool denial, tenant isolation, credential revocation and
expiry, timeout/throttling behavior, log redaction, and absence of wallet keys,
signing tools, payment tools, and private context from Runtime/Gateway traffic.
Only then may the mode change to `aws` and the result be described as deployed.

Resource creation or activation can incur AgentCore Runtime/Gateway, Identity,
CloudWatch, target-service, model, storage, data-transfer, and log-retention
charges. Creation, deployment, sustained test traffic, or a paid target requires
the operator's explicit cost approval. Cleanup is an account-tested,
best-effort operator procedure; neither the local templates nor resource TTLs
guarantee deletion or eliminate costs.

Remaining implementation/account work before live deployment:

- select and prove the supported inbound identity path that delivers the
  per-invocation workload token; the current IAM-only Pilot call is not accepted
  as proof;
- run and inspect the implemented deterministic Lambda bundle, create the
  reviewed versioned zip, deploy the reviewed
  fail-closed Lambda resource, then complete the two-phase target-ID binding;
- finish and test the concrete AWS SDK DynamoDB replay transport/composition,
  then build and inspect the ARM64 image, validate CloudFormation and IAM policies in
  the destination account, then use the staged Create -> READY -> mandatory
  MMDSv2 Update -> READY -> Get attestation sequence in `infra/agentcore`;
- account-test Gateway session compatibility, JWT expiry/revocation, tenant
  isolation, throttling, log redaction, and the unverified session-cleanup/
  cancellation behavior; and
- add a dedicated product UI affordance after the separate UI branch lands.
  Today this is an explicit API-only `operation: "agentcore_research"` path,
  not an ordinary-chat feature.

The current Gateway transport supports `CUSTOM_JWT`. Selecting an `AWS_IAM`
Gateway requires a separate SigV4 Gateway transport. Runtime OAuth invocation
also remains deliberately unsupported.

## Adjacent AWS trust services

AgentCore is independent from Pilot's Bedrock model provider and Harbor's
Guardrails/KMS paths. Enabling one does not enable the others.

- Pilot's `BEDROCK_MODE=aws` path requires an approved exact model allowlist,
  positive daily turn cap, `us-east-1`, and a short-lived server-side
  `AWS_BEARER_TOKEN_BEDROCK`. The current model adapter does not use the
  AgentCore caller role or normal SDK credential chain. Its current default is
  the explicitly labelled `mock` mode, not live AWS.
- Harbor's `GUARDRAILS_MODE=aws` path calls `bedrock:InvokeGuardrailChecks`.
  AWS documents that action with `Resource: "*"`; Harbor owns the threshold and
  fail-closed block/redaction behavior. It is not an AgentCore policy engine.
- `KMS_MODE=sign` needs only runtime `kms:Sign` and `kms:GetPublicKey` on the
  exact tagged Testnet/devnet Ed25519 keys. `KMS_MODE=kek` instead needs
  `kms:Decrypt` on the exact `alias/harbor/kek` key. These modes are an explicit
  operator choice with no automatic fallback.

Do not attach `services/harbor/scripts/aws/iam-harbor-worker.json` unchanged to
any runtime. It also contains provisioning and deletion permissions. Split key
creation, tagging, alias management, cleanup, and `iam:PassRole` into a separate
human-operated management role before live setup.
