# AgentCore account-time templates

These files are inert, account-neutral review artifacts. Do not deploy them or
replace placeholders until the account owner approves the account, Region,
roles, target, identity provider, retention, and spend.

AWS currently documents AgentCore Runtime, Gateway, and Identity support in US
East (Ohio), `us-east-2`. The inert examples use that Region because the event
account reports access there. Validation also accepts `us-east-1`, but requires
the selected Region to match the Runtime environment, ECR image, and Gateway
endpoint exactly. Region availability does not prove the account has permission
to create or invoke any resource. See
https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-regions.html.
Runtime configuration uses `AGENTCORE_AWS_REGION`; it does not consume or alter
the global `AWS_REGION` policy owned by the existing Bedrock and Harbor paths.

`gateway-and-roles.template.json` contains only supported CloudFormation
resources: a `CUSTOM_JWT` MCP Gateway pinned to `2025-11-25`, one Lambda-backed
read target, one retained durable Runtime replay table, and separate Runtime and Gateway
execution roles. The execution
roles explicitly deny IAM, KMS, secret-store, and role-switching authority. They
cannot access Harbor signing or x402 keys. The Runtime role has exactly one
AgentCore Identity read action: `GetResourceOauth2Token`, scoped to one
same-account default workload-identity directory, one named workload identity,
the same-account default token vault, and one named OAuth2 credential provider.
It explicitly denies every `GetWorkloadAccessToken*` action, so the Runtime
cannot mint the workload token required by the resource-token request.

The account owner must supply the existing `RuntimeWorkloadIdentityName` and
`RuntimeOauth2CredentialProviderName` after separately approving their OAuth
client, scopes, workload-token source, and any required user consent. This
template creates none of those identity resources, stores no client secret, and
does not grant API-key or payment-token retrieval. A successful IAM check alone
does not mean an OAuth credential or user authorization exists, so the Runtime
remains non-live until the complete account-time flow is verified.

The stack accepts `TargetLambdaFunctionName` and `RuntimeEcrRepositoryName`,
not caller-supplied ARNs. It derives both resource ARNs with `AWS::Partition`,
`AWS::Region`, and `AWS::AccountId`, so the Gateway cannot route to a Lambda or
grant image-pull access to an ECR repository in another account. The only
allowed Lambda qualifier is the literal `accepted` alias. Bootstrap points to
the unqualified, fail-closed function; activation must update the Gateway target
to the same-account `accepted` alias.

`lambda-target.template.json` declares the concrete Node.js 22 ARM64 target,
its logs-only execution role, and a retention-bounded log group. The function
reads only the fixed XRP/RLUSD XRPL Testnet spot book from the exact public
endpoint. It cannot access DynamoDB, secrets, KMS, signing, payments, or
AgentCore credential providers. Memory, timeout, ephemeral storage, reserved
concurrency, and log retention are bounded; the account owner must choose the
concurrency and retention values before any deployment.

Lambda activation is deliberately two-phase because the exact Gateway target
ID does not exist until the target references the Lambda:

1. Run `pnpm --filter @pilot/agentcore verify:lambda` and inspect the deterministic
   bundle and SHA-256 manifest in `packages/agentcore/dist/lambda`. Build a
   reviewable zip whose root contains the bundled ESM `lambda-entry.mjs`,
   `manifest.json`, and `THIRD_PARTY_NOTICES.txt`; preserve all three files
   together. Uploading the resulting archive is an
   account-time action and is not performed here.
2. Verify the versioned S3 object in the destination account, including its
   checksum and actual owner. CloudFormation permits cross-account S3 packages,
   so the template's same-account owner assertion is a declaration, not proof;
   an approved operator must perform a read-only object check using the
   destination account as the expected owner.
3. Create the Lambda stack with both configured ID parameters empty. The
   Gateway/target environment variables are absent, the handler rejects every
   invocation, and no accepted version or alias exists.
4. Create the Gateway target with `TargetLambdaQualifier` empty, record the
   exact Gateway and target IDs, then update the Lambda stack with both IDs.
   Supply the inspected versioned zip object's base64 SHA-256 value; the update
   publishes a checksum-bound version and the literal `accepted` alias. The
   build manifest's hexadecimal bundle hash is separate evidence and is not the
   zip object's `CodeSha256` value.
5. Update the Gateway stack with `TargetLambdaQualifier=accepted`. Only then may
   an approved operator run a bounded Testnet acceptance probe.

Never temporarily disable the handler's exact Gateway ID, target ID, or tool
name checks to shorten this sequence. The external Gateway tool context is the
exact empty object. Runtime separately accepts only XRP/RLUSD, the optional
fixed `xrpl-testnet-dex` venue, and the optional `spot` timeframe before it
emits that empty context; the Lambda injects the same fixed book configuration.

`RuntimeReplayTable` has string HASH key `namespace` and string RANGE key
`requestDigest`, no indexes or streams, asynchronous TTL on `expiresAt`,
point-in-time recovery, deletion protection, and retain policies. On-demand
read/write caps and the PITR window require account-owner choices. Omitting an
SSE specification deliberately uses DynamoDB's default AWS-owned encryption;
no customer or AWS-managed KMS key, KMS permission, or KMS charge is introduced.
The Runtime role can perform only strongly consistent `GetItem` and conditional
`UpdateItem` on this exact table. It cannot put, delete, scan, query, transact,
or access the table through the Lambda role.

Runtime create/update inputs carry the same complete non-secret boot inventory:
server mode, Region, Identity provider name, Gateway/tool binding, local JWT
verification policy, replay settings, and Runtime request bounds. The validator
requires exact equality across create and update and forbids static workload,
resource, bearer, access, secret, session, and web-identity token environment
variables. Replay lease is 1,000–120,000 ms; retention is
60,000–86,400,000 ms and must exceed lease. TTL is cleanup only. A dispatched
uncertain record has TTL removed and is never silently retried or expired. The
table never stores raw prompts, wallet scope, owner or tenant identifiers,
tokens, credentials, or private material.

The checked-in replay adapter uses the pinned official
`@aws-sdk/client-dynamodb` transport. Runtime composes it from the validated
Region and replay-table name before binding. SDK retries are disabled so an
ambiguous conditional write fails closed as `uncertain`; the adapter supplies
its own bounded deadline, forwards cancellation, and destroys the SDK client
after Runtime shutdown. Ambient AWS SDK endpoint overrides are ignored. Lambda ESM bundling and
offline smoke invocation are scripted, but creation of a versioned zip remains
a reviewed operator step. The table, bundle, and Lambda templates therefore
define reviewed account-time resources and interfaces, not deployed or
live-ready evidence.

CloudFormation's current `AWS::BedrockAgentCore::Runtime` schema does not expose
`metadataConfiguration`. Because `requireMMDSV2=true` is mandatory after
June 30, 2026, this directory deliberately does not declare a Runtime resource.
`runtime-create.input.schema.json` is the fail-closed wrapper for the first
reviewed control-plane call. Only its `createInput` member is sent as the
`CreateAgentRuntime` request body. The create API does not accept
`metadataConfiguration`, so a successful create produces a temporary,
unverified Runtime that must not receive an endpoint or invocation permission.
Its example uses only zero-account placeholders and requires an image digest
rather than a mutable tag.

Runtime activation is deliberately staged and non-atomic:

1. Submit the validated `createInput` from `runtime-create.example.json`, wait
   for the new Runtime to reach `READY`, and record its exact ID and version.
2. Substitute that ID into `runtime-update-mmdsv2.example.json`, validate it
   against `runtime-update-mmdsv2.input.schema.json`, and submit its
   `updateInput` as the `UpdateAgentRuntime` request body. This repeats the
   pinned artifact, role, protocol, and network settings while adding
   `metadataConfiguration.requireMMDSV2=true`.
3. Wait for the updated Runtime to reach `READY`, then call `GetAgentRuntime`
   for the exact returned version. Attest that the response still contains the
   expected image digest, role, protocol, network, and complete non-secret
   Runtime environment and reports
   `metadataConfiguration.requireMMDSV2=true`.
4. Only after that attestation may an approved operator create an endpoint and
   deploy the second-stage caller role. If create, update, readiness, or
   attestation fails, stop with no endpoint or invocation permission and have
   the account owner explicitly delete or roll back the temporary Runtime.

This directory does not automate deployment or rollback. It also does not
claim atomic MMDSv2 enforcement: the mandatory setting can only be applied by
the documented post-create update with the current service API.

Both Runtime wrappers require one `destinationAccountId`. Before either AWS
call, run the executable validator against the substituted create and update
files. It fails unless the ECR image URI and Runtime execution-role ARN use that
same destination account, the create and update account IDs match, and the
update preserves the create artifact, role, protocol, network, and complete
non-secret Runtime environment settings:

```sh
node infra/agentcore/validate.mjs path/to/runtime-create.json path/to/runtime-update.json
```

The wrapper-only `destinationAccountId`, `region`, and verification fields are
not sent in AWS request bodies; only `createInput` or `updateInput` is sent.

Gateway JWT configuration declares the discovery URL, audience, client,
subject, exact deployment-tenant claim name/value, and one read scope for
account-time validation. Pass the same tenant claim name and deployment value
used by the Runtime environment and `postCreateVerification`; a subject match
alone is insufficient. The offline checks do
not fetch or validate OIDC discovery metadata. The Runtime verifier additionally binds
the JWT tenant claim to one configured `deploymentTenantId` representing the
approved deployment/workload. That value must be assigned independently and
must never be derived from an owner address, wallet session, or wallet tenant.
The dynamic wallet tenant remains separately bound inside each Runtime
invocation's scope and digest chain; the JWT deployment tenant does not replace
or impersonate it.

Issuer/JWKS validation rejects literal IPs, localhost, redirects, and a JWKS
origin different from the configured issuer. The destination deployment must
still constrain DNS and egress and verify discovery/JWKS resolution in-account;
syntax and same-origin checks alone do not prove resistance to DNS rebinding or
an operator-controlled issuer.

After the Runtime exists and passes MMDSv2 attestation, deploy
`caller-role.template.json` as a second stack with its exact `RuntimeId` and one
existing `PilotCallerRoleName`. The template derives both the Runtime ARN and
caller principal ARN from `AWS::Partition`, `AWS::Region`, and
`AWS::AccountId`; it accepts neither a caller ARN nor a Runtime ARN. Account
root and cross-account principals/resources are therefore not configurable.
This split avoids weakening the caller policy with a pre-creation Runtime
wildcard.

`operator-management.policy.template.json` is kept separate because it contains
resource-management and deletion actions. Its literal `ACCOUNT_ID` and `REGION`
tokens are placeholders, not deployable values. An account owner must replace every
placeholder, independently review the resulting scope, and decide who may
assume that role. The policy denies KMS, Secrets Manager, and Parameter Store
management and cannot create, tag, alias, sign with, decrypt with, or delete a
Harbor key. Key management is intentionally absent.

Lambda, DynamoDB, log-group, package-upload, and stack-management permissions
are not granted to either execution role and are not added to this operator
policy. A destination-account administrator must separately review any
CloudFormation execution/deployment role, cost caps, versioned package, PITR
window, retention, and rollback/delete action. These templates never authorize
their own creation or deletion.

Run the offline structural and security-boundary check with:

```sh
node infra/agentcore/validate.mjs
```

This does not call AWS and is not CloudFormation deployment evidence. All
templates remain inert until both CloudFormation validation and IAM simulation
run in the approved destination account. Live
validation still requires account-specific CloudFormation validation, a pinned
ARM64 ECR image digest, the exact Lambda target ARN, IdP discovery/audience/
client/subject/tenant values, role ARNs, and explicit deployment approval.

Official schema references:

- <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-gateway.html>
- <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-gatewaytarget.html>
- <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-runtime.html>
- <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-lambda-function.html>
- <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-function-code.html>
- <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-dynamodb-table.html>
- <https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-logs-loggroup.html>
- <https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateAgentRuntime.html>
- <https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_UpdateAgentRuntime.html>
- <https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_GetAgentRuntime.html>
- <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/scope-credential-provider-access.html>
- <https://docs.aws.amazon.com/service-authorization/latest/reference/list_bedrock-agentcore.html>
- <https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_GetResourceOauth2Token.html>
- <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-permissions.html>
- <https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-prerequisites-permissions.html>
