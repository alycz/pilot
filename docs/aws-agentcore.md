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
loopback origin and labels every result synthetic. `aws` requires an explicit
Runtime authentication mode; it never falls back between modes. The documented
workload-token path is `oauth_jwt`: Pilot obtains a fresh access token through
an injected server-only resolver, verifies its issuer, signature, token type,
exact audience, subject, client, scope, deployment tenant, lifetime, and the
configured revocation policy, then invokes the exact regional Runtime HTTPS
endpoint with `Authorization: Bearer`. AWS explicitly does not support this
bearer flow through `InvokeAgentRuntimeCommand`. A separate explicit `iam` mode
retains the official SDK/SigV4 adapter for a separately configured Runtime but
is not accepted as workload-token readiness evidence. No access token can be
read from environment configuration.

Both AWS modes require an exact Runtime ARN, qualifier, Region, Gateway URL,
and deployed Gateway-visible tool name. The Runtime request and response bind
digests of that Gateway configuration, the server-derived scope, and the read
request. The HTTPS caller uses a fresh UUID Runtime session and accepts an
echoed session header only when it matches.
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
composes the pinned official DynamoDB SDK with the validated table name and
Region. SDK retries are disabled and replay calls have bounded deadlines, so an
ambiguous write fails closed instead of being silently replayed. Graceful
Runtime shutdown also destroys the SDK client and its pooled transports;
ambient AWS SDK endpoint overrides are ignored. The image has
not been built, pushed, or run on AgentCore; account-side bootability remains
unproven.

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

- one AgentCore Runtime version/endpoint in `us-east-2`, with an execution role
  limited to the one research path and
  `metadataConfiguration.requireMMDSV2=true`;
- one separately authenticated AgentCore MCP Gateway;
- one read-only Gateway target whose visible name exactly matches
  `${target_name}___${tool_name}` and whose output matches the strict market
  context contract;
- one Runtime inbound `CUSTOM_JWT` authorizer with a reviewed discovery URL,
  singleton audience/client/scope, and exact subject and deployment-tenant
  claims. This is the documented path by which AgentCore validates Pilot's
  short-lived JWT, calls `GetWorkloadAccessTokenForJWT`, and injects the opaque
  `WorkloadAccessToken` into the container;
- a separate Gateway inbound `CUSTOM_JWT` configuration whose issuer/discovery
  URL and audience validate the short-lived resource token obtained by the
  Runtime, with exact subject and deployment-tenant policy matching the local
  Runtime verifier; and
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

- `AGENTCORE_AWS_REGION=us-east-2`;
- `AGENTCORE_RUNTIME_ARN` and `AGENTCORE_RUNTIME_QUALIFIER`;
- `AGENTCORE_RUNTIME_AUTH_MODE=oauth_jwt` plus the exact inbound issuer, JWKS,
  audience, subject, client, scope, deployment-tenant, algorithm, token-lifetime,
  JWKS-cache, and revocation-policy fields shown in the template;
- the exact `/mcp` `AGENTCORE_GATEWAY_URL`;
- the exact target-prefixed `AGENTCORE_GATEWAY_TOOL_NAME`; and
- the fixed auth/protocol settings in the template.

`AGENTCORE_AWS_REGION` is intentionally independent from the global
`AWS_REGION` used by existing Bedrock and Harbor paths. AgentCore never changes,
defaults, or interprets those integrations' Region policy.

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

The supported JWT Runtime must be invoked only through the reviewed server-side
OAuth resolver; Builder ID console login is not a Runtime identity provider.
Keep the Runtime execution role, Gateway execution role, and resource-management
role separate. An IAM caller role applies only to a separately created
IAM-authorized Runtime and cannot invoke the JWT Runtime. Enter target
credentials only in the approved AgentCore Identity/Secrets workflow under the
operator's account.
Do not put AWS access keys, JWTs, OAuth client secrets, target API keys, or token
values in the repository, an env template, chat, logs, model context, tool
arguments, or receipts.

Important identity gate: the JWT/HTTPS caller, strict Runtime authorizer inputs,
and workload-token-consuming container are implemented, but the account has no
approved IdP application or deployed Runtime. The caller therefore requires an
injected server-only token resolver and fails closed when it is absent. Do not
add a static token, reuse a Gateway resource token as a Runtime token, or derive
an opaque delegated user ID from a browser-supplied wallet field as a shortcut.

Self-contained JWT revocation is either explicitly `expiry_only`, bounded by the
reviewed maximum age/lifetime and JWKS cache, or `checker`, which requires a
provider-backed injected checker and a token `jti`. Checker failure, timeout,
abort, unknown state, or a revoked result all fail closed before replay lookup.
Offline checker fixtures prove this composition; no live provider revocation or
AWS-delivered workload token has been tested.

The configured JWT issuer and same-origin JWKS URL are security boundaries.
Code rejects literal IPs, localhost, redirects, and cross-origin JWKS, but DNS
resolution and egress policy are deployment controls. Before activation, pin an
approved issuer, constrain Runtime DNS/egress, and verify discovery and JWKS
resolution inside the destination account. Local URL validation alone is not
SSRF or DNS-rebinding proof.

Local verification uses `AGENTCORE_MODE=standin` with the loopback server from
the integration test and must retain the synthetic provenance label. The
`acceptance:identity:offline` harness composes synthetic Identity exchange,
JWKS/JWT checks, revocation, Gateway MCP, replay, and the Runtime header boundary;
it emits only redacted synthetic evidence and makes zero AWS calls. Its separate
live preflight has no live transport and cannot activate a service. Live
acceptance must separately demonstrate Runtime JWT enforcement, AWS workload-
token delivery, Gateway JWT
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

- approve and configure the actual OAuth/OIDC application, then supply its
  discovery URL/issuer, JWKS URL, client ID, Runtime audience, exact subject,
  dedicated scope, deployment-tenant claim/value, token TTL/skew, and revocation
  semantics to the server-only resolver and inert Runtime inputs;
- run and inspect the implemented deterministic Lambda bundle, create the
  reviewed versioned zip, deploy the reviewed
  fail-closed Lambda resource, then complete the two-phase target-ID binding;
- build and inspect the ARM64 image, validate CloudFormation and IAM policies in
  the destination account, then use the staged Create -> READY -> mandatory
  MMDSv2 Update -> READY -> Get attestation sequence in `infra/agentcore`;
- account-test Gateway session compatibility, JWT expiry/revocation, tenant
  isolation, throttling, log redaction, and the unverified session-cleanup/
  cancellation behavior; and
- add a dedicated product UI affordance after the separate UI branch lands.
  Today this is an explicit API-only `operation: "agentcore_research"` path,
  not an ordinary-chat feature.

The current Gateway transport supports `CUSTOM_JWT`. Selecting an `AWS_IAM`
Gateway requires a separate SigV4 Gateway transport. Runtime OAuth/JWT HTTPS
invocation is implemented; token acquisition remains an injected account-owned
boundary because no IdP or OAuth grant has been approved or created.

Authoritative AWS references for this boundary are the
[Runtime OAuth/JWT guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html),
[inbound authorizer schema](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CustomJWTAuthorizerConfiguration.html),
[InvokeAgentRuntime API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html),
[workload-token flow](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/get-workload-access-token.html),
and [Region matrix](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html).

## Adjacent AWS trust services

AgentCore is independent from Pilot's Bedrock model provider and Harbor's
Guardrails/KMS paths. Enabling one does not enable the others.

- Pilot's `BEDROCK_MODE=aws` path requires an approved exact model allowlist,
  positive daily turn cap, an explicitly allowlisted `us-east-1` or
  `us-east-2` Region, and a short-lived server-side
  `AWS_BEARER_TOKEN_BEDROCK`. The approved account uses `us-east-2`; Pilot does
  not retry across Regions. The current model adapter does not use the
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
