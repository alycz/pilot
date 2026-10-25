import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("./", import.meta.url));
const readJson = async (name) => JSON.parse(await readFile(new URL(name, import.meta.url), "utf8"));
const readJsonPath = async (path) => JSON.parse(await readFile(path, "utf8"));
const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const supportedRegions = new Set(["us-east-1", "us-east-2"]);
const expectFailure = (operation, expected, label) => {
  try {
    operation();
  } catch (error) {
    assert(error instanceof Error && error.message.includes(expected), `${label}: failed for an unexpected reason`);
    return;
  }
  fail(`${label}: unexpectedly passed`);
};

const runtimeEnvironmentKeys = [
  "AGENTCORE_RUNTIME_SERVER_MODE",
  "AGENTCORE_AWS_REGION",
  "AGENTCORE_IDENTITY_CREDENTIAL_PROVIDER_NAME",
  "AGENTCORE_GATEWAY_URL",
  "AGENTCORE_GATEWAY_TOOL_NAME",
  "AGENTCORE_GATEWAY_JWT_ISSUER",
  "AGENTCORE_GATEWAY_JWT_JWKS_URL",
  "AGENTCORE_GATEWAY_JWT_AUDIENCES_JSON",
  "AGENTCORE_GATEWAY_JWT_ALLOWED_SUBJECTS_JSON",
  "AGENTCORE_GATEWAY_JWT_ALLOWED_CLIENTS_JSON",
  "AGENTCORE_GATEWAY_JWT_REQUIRED_SCOPES_JSON",
  "AGENTCORE_GATEWAY_JWT_CLIENT_CLAIM",
  "AGENTCORE_GATEWAY_JWT_TENANT_CLAIM",
  "AGENTCORE_GATEWAY_JWT_DEPLOYMENT_TENANT_ID",
  "AGENTCORE_GATEWAY_JWT_ALGORITHMS_JSON",
  "AGENTCORE_GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS",
  "AGENTCORE_GATEWAY_JWT_MAX_TOKEN_AGE_SECONDS",
  "AGENTCORE_GATEWAY_JWT_MAX_TOKEN_LIFETIME_SECONDS",
  "AGENTCORE_GATEWAY_JWT_JWKS_CACHE_TTL_MS",
  "AGENTCORE_GATEWAY_JWT_JWKS_REFRESH_COOLDOWN_MS",
  "AGENTCORE_GATEWAY_JWT_REVOCATION_MODE",
  "AGENTCORE_REPLAY_TABLE",
  "AGENTCORE_REPLAY_DEPLOYMENT_ID",
  "AGENTCORE_REPLAY_LEASE_MS",
  "AGENTCORE_REPLAY_RETENTION_MS",
  "AGENTCORE_RUNTIME_REQUEST_TIMEOUT_MS",
  "AGENTCORE_RUNTIME_MAX_REQUEST_BYTES",
  "AGENTCORE_RUNTIME_MAX_RESPONSE_BYTES",
  "AGENTCORE_RUNTIME_MAX_CONCURRENT_REQUESTS",
].sort();

const exactStringList = (raw, maximum, label, accepted) => {
  assert(typeof raw === "string" && raw.length >= 3 && raw.length <= 8_192, `${label}: list JSON is missing or unbounded`);
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${label}: list JSON is invalid`);
  }
  assert(Array.isArray(value) && value.length >= 1 && value.length <= maximum, `${label}: list length is invalid`);
  assert(value.every((entry) => typeof entry === "string" && entry.length >= 1 && entry.length <= 256 && entry.trim() === entry && !/[\u0000-\u001f\u007f]/.test(entry)), `${label}: list contains an invalid value`);
  assert(new Set(value).size === value.length, `${label}: list contains a duplicate`);
  if (accepted) assert(value.every((entry) => accepted.has(entry)), `${label}: list contains an unsupported value`);
  return value;
};

const boundedInteger = (raw, minimum, maximum, label) => {
  assert(typeof raw === "string" && /^\d+$/.test(raw), `${label}: value must be an integer string`);
  const value = Number(raw);
  assert(Number.isSafeInteger(value) && value >= minimum && value <= maximum, `${label}: value is outside ${minimum}..${maximum}`);
  return value;
};

const validateJsonSchema = (schemaNode, value, path) => {
  if (Object.hasOwn(schemaNode, "const")) {
    assert(JSON.stringify(value) === JSON.stringify(schemaNode.const), `${path}: value violates const`);
  }
  if (schemaNode.enum) {
    assert(schemaNode.enum.some((entry) => JSON.stringify(entry) === JSON.stringify(value)), `${path}: value is outside enum`);
  }
  if (schemaNode.type === "object") {
    assert(value !== null && typeof value === "object" && !Array.isArray(value), `${path}: expected object`);
    for (const required of schemaNode.required ?? []) {
      assert(Object.hasOwn(value, required), `${path}: missing required property ${required}`);
    }
    if (schemaNode.additionalProperties === false) {
      const allowed = new Set(Object.keys(schemaNode.properties ?? {}));
      for (const property of Object.keys(value)) assert(allowed.has(property), `${path}: unexpected property ${property}`);
    }
    for (const [property, propertySchema] of Object.entries(schemaNode.properties ?? {})) {
      if (Object.hasOwn(value, property)) validateJsonSchema(propertySchema, value[property], `${path}.${property}`);
    }
  }
  if (schemaNode.type === "array") {
    assert(Array.isArray(value), `${path}: expected array`);
    if (schemaNode.minItems !== undefined) assert(value.length >= schemaNode.minItems, `${path}: array is too short`);
    if (schemaNode.maxItems !== undefined) assert(value.length <= schemaNode.maxItems, `${path}: array is too long`);
    if (schemaNode.uniqueItems === true) {
      assert(new Set(value.map((entry) => JSON.stringify(entry))).size === value.length, `${path}: array contains a duplicate`);
    }
    if (schemaNode.items && typeof schemaNode.items === "object") {
      value.forEach((entry, index) => validateJsonSchema(schemaNode.items, entry, `${path}[${index}]`));
    }
  }
  if (schemaNode.type === "string") {
    assert(typeof value === "string", `${path}: expected string`);
    if (schemaNode.minLength !== undefined) assert(value.length >= schemaNode.minLength, `${path}: string is too short`);
    if (schemaNode.maxLength !== undefined) assert(value.length <= schemaNode.maxLength, `${path}: string is too long`);
    if (schemaNode.pattern !== undefined) assert(new RegExp(schemaNode.pattern).test(value), `${path}: string violates pattern`);
  }
};

const validateRuntimeAccountBinding = (createDocument, updateDocument, label) => {
  validateJsonSchema(schema, createDocument, `${label}: create`);
  validateJsonSchema(updateSchema, updateDocument, `${label}: update`);
  const destinationAccountId = createDocument.destinationAccountId;
  const region = createDocument.region;
  assert(supportedRegions.has(region), `${label}: create Region is unsupported`);
  assert(updateDocument.region === region, `${label}: create and update Regions differ`);
  assert(/^[0-9]{12}$/.test(destinationAccountId), `${label}: create destinationAccountId is invalid`);
  assert(updateDocument.destinationAccountId === destinationAccountId, `${label}: create and update destination accounts differ`);

  for (const [phase, input] of [["create", createDocument.createInput], ["update", updateDocument.updateInput]]) {
    assert(input && typeof input === "object", `${label}: ${phase} input is missing`);
    const containerUri = input.agentRuntimeArtifact?.containerConfiguration?.containerUri;
    const ecrMatch = typeof containerUri === "string"
      ? containerUri.match(/^([0-9]{12})\.dkr\.ecr\.(us-east-[12])\.amazonaws\.com\//)
      : undefined;
    const ecrAccountId = ecrMatch?.[1];
    const ecrRegion = ecrMatch?.[2];
    const roleAccountId = typeof input.roleArn === "string"
      ? input.roleArn.match(/^arn:aws:iam::([0-9]{12}):role\//)?.[1]
      : undefined;
    assert(ecrAccountId === destinationAccountId, `${label}: ${phase} ECR image is not in the destination account`);
    assert(ecrRegion === region, `${label}: ${phase} ECR image is not in the selected Region`);
    assert(roleAccountId === destinationAccountId, `${label}: ${phase} Runtime role is not in the destination account`);
  }

  assert(JSON.stringify(updateDocument.updateInput.agentRuntimeArtifact) === JSON.stringify(createDocument.createInput.agentRuntimeArtifact), `${label}: update must preserve the pinned create artifact`);
  assert(updateDocument.updateInput.roleArn === createDocument.createInput.roleArn, `${label}: update must preserve the create role`);
  assert(JSON.stringify(updateDocument.updateInput.authorizerConfiguration) === JSON.stringify(createDocument.createInput.authorizerConfiguration), `${label}: update must preserve the complete create Runtime authorizer`);
  assert(JSON.stringify(updateDocument.updateInput.protocolConfiguration) === JSON.stringify(createDocument.createInput.protocolConfiguration), `${label}: update must preserve the create protocol`);
  assert(JSON.stringify(updateDocument.updateInput.networkConfiguration) === JSON.stringify(createDocument.createInput.networkConfiguration), `${label}: update must preserve the create network configuration`);
  assert(JSON.stringify(updateDocument.updateInput.environmentVariables) === JSON.stringify(createDocument.createInput.environmentVariables), `${label}: update must preserve the complete create Runtime environment`);
  assert(createDocument.createInput.requestHeaderConfiguration === undefined && updateDocument.updateInput.requestHeaderConfiguration === undefined, `${label}: Runtime must not forward the inbound Authorization header`);
  const runtimeAuthorizer = createDocument.createInput.authorizerConfiguration?.customJWTAuthorizer;
  const runtimeVerification = createDocument.postCreateVerification?.runtimeInboundJwt;
  assert(runtimeAuthorizer && runtimeVerification, `${label}: Runtime CUSTOM_JWT authorizer is missing`);
  assert(runtimeVerification.authMode === "CUSTOM_JWT", `${label}: Runtime auth mode must be CUSTOM_JWT`);
  assert(runtimeAuthorizer.discoveryUrl === runtimeVerification.discoveryUrl, `${label}: Runtime discovery URL differs from verification`);
  assert(new URL(runtimeVerification.discoveryUrl).origin === new URL(runtimeVerification.issuer).origin, `${label}: Runtime discovery and issuer origins differ`);
  assert(JSON.stringify(runtimeAuthorizer.allowedAudience) === JSON.stringify([runtimeVerification.audience]), `${label}: Runtime inbound audience differs from verification`);
  assert(JSON.stringify(runtimeAuthorizer.allowedClients) === JSON.stringify([runtimeVerification.clientId]), `${label}: Runtime inbound client differs from verification`);
  assert(JSON.stringify(runtimeAuthorizer.allowedScopes) === JSON.stringify([runtimeVerification.allowedScope]), `${label}: Runtime inbound scope differs from verification`);
  assert(runtimeAuthorizer.customClaims.length === 2, `${label}: Runtime must bind exactly subject and deployment tenant claims`);
  const [runtimeSubjectClaim, runtimeTenantClaim] = runtimeAuthorizer.customClaims;
  assert(
    runtimeSubjectClaim.inboundTokenClaimName === "sub" &&
      runtimeSubjectClaim.inboundTokenClaimValueType === "STRING" &&
      runtimeSubjectClaim.authorizingClaimMatchValue.claimMatchOperator === "EQUALS" &&
      runtimeSubjectClaim.authorizingClaimMatchValue.claimMatchValue.matchValueString === runtimeVerification.subject,
    `${label}: Runtime inbound subject claim differs from verification`,
  );
  assert(
    runtimeTenantClaim.inboundTokenClaimName === runtimeVerification.tenantClaimName &&
      runtimeTenantClaim.inboundTokenClaimValueType === "STRING" &&
      runtimeTenantClaim.authorizingClaimMatchValue.claimMatchOperator === "EQUALS" &&
      runtimeTenantClaim.authorizingClaimMatchValue.claimMatchValue.matchValueString === runtimeVerification.deploymentTenantId,
    `${label}: Runtime inbound deployment tenant claim differs from verification`,
  );
  const environment = createDocument.createInput.environmentVariables;
  assert(environment && JSON.stringify(Object.keys(environment).sort()) === JSON.stringify(runtimeEnvironmentKeys), `${label}: Runtime environment inventory is not exact`);
  assert(environment.AGENTCORE_RUNTIME_SERVER_MODE === "aws", `${label}: Runtime server mode must be aws`);
  assert(environment.AGENTCORE_AWS_REGION === region, `${label}: Runtime environment Region differs from the selected Region`);
  assert(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(environment.AGENTCORE_IDENTITY_CREDENTIAL_PROVIDER_NAME), `${label}: Identity credential-provider name is invalid`);
  const gatewayRegion = environment.AGENTCORE_GATEWAY_URL.match(/^https:\/\/[0-9a-z](?:[0-9a-z-]{0,98}[0-9a-z])?-[0-9a-z]{10}\.gateway\.bedrock-agentcore\.(us-east-[12])\.amazonaws\.com\/mcp$/)?.[1];
  assert(gatewayRegion === region, `${label}: Gateway URL is not in the selected Region`);
  assert(/^[A-Za-z0-9_-]+___pilot\.read_market_context$/.test(environment.AGENTCORE_GATEWAY_TOOL_NAME), `${label}: Gateway tool name is invalid`);
  for (const name of ["AGENTCORE_GATEWAY_JWT_ISSUER", "AGENTCORE_GATEWAY_JWT_JWKS_URL"]) {
    assert(typeof environment[name] === "string" && environment[name].length <= 2_048 && /^https:\/\/[^?#]+$/.test(environment[name]), `${label}: ${name} must be a bounded HTTPS URL`);
  }
  const audiences = exactStringList(environment.AGENTCORE_GATEWAY_JWT_AUDIENCES_JSON, 8, `${label}: JWT audiences`);
  const subjects = exactStringList(environment.AGENTCORE_GATEWAY_JWT_ALLOWED_SUBJECTS_JSON, 1, `${label}: JWT subjects`);
  const clients = exactStringList(environment.AGENTCORE_GATEWAY_JWT_ALLOWED_CLIENTS_JSON, 1, `${label}: JWT clients`);
  const scopes = exactStringList(environment.AGENTCORE_GATEWAY_JWT_REQUIRED_SCOPES_JSON, 16, `${label}: JWT scopes`);
  const algorithms = exactStringList(environment.AGENTCORE_GATEWAY_JWT_ALGORITHMS_JSON, 2, `${label}: JWT algorithms`, new Set(["RS256", "ES256"]));
  assert(["client_id", "azp"].includes(environment.AGENTCORE_GATEWAY_JWT_CLIENT_CLAIM), `${label}: JWT client claim is invalid`);
  assert(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(environment.AGENTCORE_GATEWAY_JWT_TENANT_CLAIM), `${label}: JWT tenant claim is invalid`);
  assert(typeof environment.AGENTCORE_GATEWAY_JWT_DEPLOYMENT_TENANT_ID === "string" && environment.AGENTCORE_GATEWAY_JWT_DEPLOYMENT_TENANT_ID.length >= 1 && environment.AGENTCORE_GATEWAY_JWT_DEPLOYMENT_TENANT_ID.length <= 256, `${label}: JWT deployment tenant is invalid`);
  assert(algorithms.length >= 1, `${label}: at least one asymmetric JWT algorithm is required`);
  boundedInteger(environment.AGENTCORE_GATEWAY_JWT_CLOCK_TOLERANCE_SECONDS, 0, 60, `${label}: JWT clock tolerance`);
  boundedInteger(environment.AGENTCORE_GATEWAY_JWT_MAX_TOKEN_AGE_SECONDS, 30, 3_600, `${label}: JWT maximum token age`);
  boundedInteger(environment.AGENTCORE_GATEWAY_JWT_MAX_TOKEN_LIFETIME_SECONDS, 30, 3_600, `${label}: JWT maximum token lifetime`);
  boundedInteger(environment.AGENTCORE_GATEWAY_JWT_JWKS_CACHE_TTL_MS, 1_000, 900_000, `${label}: JWT JWKS cache TTL`);
  boundedInteger(environment.AGENTCORE_GATEWAY_JWT_JWKS_REFRESH_COOLDOWN_MS, 1_000, 60_000, `${label}: JWT JWKS refresh cooldown`);
  assert(environment.AGENTCORE_GATEWAY_JWT_REVOCATION_MODE === "expiry_only", `${label}: Runtime template must disclose expiry-only revocation`);
  const verification = createDocument.postCreateVerification;
  assert(verification && environment.AGENTCORE_GATEWAY_URL === verification.gateway.url, `${label}: Runtime Gateway URL differs from the verified Gateway`);
  assert(environment.AGENTCORE_GATEWAY_TOOL_NAME === verification.gateway.toolName, `${label}: Runtime Gateway tool differs from the verified tool`);
  assert(environment.AGENTCORE_GATEWAY_JWT_ISSUER === verification.jwtVerification.issuer, `${label}: Runtime JWT issuer differs from the verified issuer`);
  assert(JSON.stringify(audiences) === JSON.stringify([verification.jwtVerification.audience]), `${label}: Runtime audience differs from the verified audience`);
  assert(JSON.stringify(subjects) === JSON.stringify([verification.jwtVerification.subject]), `${label}: Runtime subject differs from the verified subject`);
  assert(JSON.stringify(clients) === JSON.stringify([verification.jwtVerification.clientId]), `${label}: Runtime client differs from the verified client`);
  assert(JSON.stringify(scopes) === JSON.stringify([verification.jwtVerification.allowedScope]), `${label}: Runtime scope differs from the verified scope`);
  assert(environment.AGENTCORE_GATEWAY_JWT_TENANT_CLAIM === verification.jwtVerification.tenantClaimName, `${label}: Runtime tenant claim differs from the verified claim`);
  assert(environment.AGENTCORE_GATEWAY_JWT_DEPLOYMENT_TENANT_ID === verification.jwtVerification.deploymentTenantId, `${label}: Runtime deployment tenant differs from verification`);
  assert(runtimeVerification.audience !== verification.jwtVerification.audience, `${label}: Runtime and Gateway JWT audiences must be distinct`);
  assert(runtimeVerification.clientId !== verification.jwtVerification.clientId, `${label}: Runtime and Gateway JWT clients must be distinct`);
  assert(runtimeVerification.allowedScope !== verification.jwtVerification.allowedScope, `${label}: Runtime and Gateway JWT scopes must be distinct`);
  assert(/^[A-Za-z0-9_.-]{3,255}$/.test(environment.AGENTCORE_REPLAY_TABLE), `${label}: replay table name is invalid`);
  assert(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(environment.AGENTCORE_REPLAY_DEPLOYMENT_ID), `${label}: replay deployment ID is invalid`);
  const replayLeaseMs = boundedInteger(environment.AGENTCORE_REPLAY_LEASE_MS, 1_000, 120_000, `${label}: replay lease`);
  const replayRetentionMs = boundedInteger(environment.AGENTCORE_REPLAY_RETENTION_MS, 60_000, 86_400_000, `${label}: replay retention`);
  assert(replayRetentionMs > replayLeaseMs, `${label}: replay retention must exceed its lease`);
  boundedInteger(environment.AGENTCORE_RUNTIME_REQUEST_TIMEOUT_MS, 100, 60_000, `${label}: request timeout`);
  boundedInteger(environment.AGENTCORE_RUNTIME_MAX_REQUEST_BYTES, 1_024, 1_048_576, `${label}: maximum request bytes`);
  boundedInteger(environment.AGENTCORE_RUNTIME_MAX_RESPONSE_BYTES, 1_024, 1_048_576, `${label}: maximum response bytes`);
  boundedInteger(environment.AGENTCORE_RUNTIME_MAX_CONCURRENT_REQUESTS, 1, 32, `${label}: maximum concurrent requests`);
  assert(updateDocument.updateInput.metadataConfiguration?.requireMMDSV2 === true, `${label}: update must require MMDSv2`);
};

const template = await readJson("gateway-and-roles.template.json");
const lambdaTemplate = await readJson("lambda-target.template.json");
const caller = await readJson("caller-role.template.json");
const schema = await readJson("runtime-create.input.schema.json");
const example = await readJson("runtime-create.example.json");
const updateSchema = await readJson("runtime-update-mmdsv2.input.schema.json");
const updateExample = await readJson("runtime-update-mmdsv2.example.json");
const operator = await readJson("operator-management.policy.template.json");

assert(template.Resources.ResearchGateway.Type === "AWS::BedrockAgentCore::Gateway", "Gateway resource is missing");
assert(template.Resources.ResearchGatewayTarget.Type === "AWS::BedrockAgentCore::GatewayTarget", "Gateway target is missing");
assert(!Object.values(template.Resources).some((resource) => resource.Type === "AWS::BedrockAgentCore::Runtime"), "Runtime must not be created by incomplete CloudFormation support");
assert(template.Resources.ResearchGateway.Properties.AuthorizerType === "CUSTOM_JWT", "Gateway must use CUSTOM_JWT");
assert(template.Resources.ResearchGateway.Properties.ProtocolConfiguration.Mcp.SupportedVersions.length === 1, "Gateway must pin one MCP version");
assert(template.Resources.ResearchGateway.Properties.ProtocolConfiguration.Mcp.SupportedVersions[0] === "2025-11-25", "Gateway MCP version drifted");
assert(template.Parameters.TargetLambdaArn === undefined, "Gateway must not accept an arbitrary Lambda ARN");
assert(template.Parameters.RuntimeEcrRepositoryArn === undefined, "Runtime role must not accept an arbitrary ECR ARN");
assert(template.Parameters.TargetLambdaFunctionName?.AllowedPattern === "^[A-Za-z0-9_-]{1,64}$", "Lambda name boundary changed");
assert(template.Parameters.RuntimeEcrRepositoryName?.AllowedPattern === "^[a-z0-9]+(?:[._/-][a-z0-9]+)*$", "ECR repository name boundary changed");
assert(template.Parameters.RuntimeWorkloadIdentityName?.AllowedPattern === "^[A-Za-z0-9_.-]{3,255}$", "Workload identity name boundary changed");
assert(template.Parameters.RuntimeOauth2CredentialProviderName?.AllowedPattern === "^[A-Za-z0-9_-]{1,128}$", "OAuth2 provider name boundary changed");
assert(template.Parameters.JwtTenantClaimName?.AllowedPattern === "^[A-Za-z][A-Za-z0-9_.:-]{0,127}$", "Gateway JWT tenant claim-name boundary changed");
assert(template.Parameters.JwtDeploymentTenantId?.AllowedPattern === "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$", "Gateway JWT deployment-tenant boundary changed");
assert(JSON.stringify(template.Parameters.TargetLambdaQualifier?.AllowedValues) === JSON.stringify(["", "accepted"]), "Gateway target qualifier must remain bootstrap-or-accepted only");
const gatewayCustomClaims = template.Resources.ResearchGateway.Properties.AuthorizerConfiguration.CustomJWTAuthorizer.CustomClaims;
assert(gatewayCustomClaims.length === 2, "Gateway must bind exactly subject and deployment tenant claims");
assert(gatewayCustomClaims[0].InboundTokenClaimName === "sub" && gatewayCustomClaims[0].AuthorizingClaimMatchValue.ClaimMatchOperator === "EQUALS" && gatewayCustomClaims[0].AuthorizingClaimMatchValue.ClaimMatchValue.MatchValueString.Ref === "JwtSubject", "Gateway subject claim binding changed");
assert(gatewayCustomClaims[1].InboundTokenClaimName.Ref === "JwtTenantClaimName" && gatewayCustomClaims[1].InboundTokenClaimValueType === "STRING" && gatewayCustomClaims[1].AuthorizingClaimMatchValue.ClaimMatchOperator === "EQUALS" && gatewayCustomClaims[1].AuthorizingClaimMatchValue.ClaimMatchValue.MatchValueString.Ref === "JwtDeploymentTenantId", "Gateway deployment tenant claim binding changed");

const lambdaFunction = lambdaTemplate.Resources.PublicMarketTargetFunction;
const lambdaRole = lambdaTemplate.Resources.TargetLambdaExecutionRole;
const lambdaLogGroup = lambdaTemplate.Resources.TargetLogGroup;
assert(lambdaFunction?.Type === "AWS::Lambda::Function", "Concrete public-market Lambda target is missing");
assert(lambdaFunction.Properties.Runtime === "nodejs22.x" && lambdaFunction.Properties.Architectures[0] === "arm64", "Lambda runtime or architecture changed");
assert(lambdaFunction.Properties.Handler === "lambda-entry.handler" && lambdaFunction.Properties.PackageType === "Zip", "Lambda package contract changed");
assert(lambdaFunction.Properties.MemorySize === 256 && lambdaFunction.Properties.Timeout === 10 && lambdaFunction.Properties.EphemeralStorage.Size === 512, "Lambda bounded compute settings changed");
assert(lambdaFunction.Properties.Code.S3Bucket.Ref === "LambdaPackageBucketName" && lambdaFunction.Properties.Code.S3Key.Ref === "LambdaPackageKey" && lambdaFunction.Properties.Code.S3ObjectVersion.Ref === "LambdaPackageObjectVersion", "Lambda must use one versioned package declaration");
assert(lambdaTemplate.Parameters.LambdaPackageSha256Base64?.AllowedPattern === "^[A-Za-z0-9+/]{43}=$", "Lambda package checksum boundary changed");
assert(lambdaFunction.Properties.KmsKeyArn === undefined && lambdaFunction.Properties.VpcConfig === undefined && lambdaFunction.Properties.DeadLetterConfig === undefined, "Lambda must not add KMS, VPC, or dead-letter authority");
const lambdaEnvironmentKeys = Object.keys(lambdaFunction.Properties.Environment.Variables).sort();
assert(JSON.stringify(lambdaEnvironmentKeys) === JSON.stringify([
  "AGENTCORE_LAMBDA_GATEWAY_ID",
  "AGENTCORE_LAMBDA_TARGET_ID",
  "AGENTCORE_LAMBDA_TARGET_NAME",
  "AGENTCORE_MARKET_MAX_LEDGER_AGE_SECONDS",
  "AGENTCORE_MARKET_RLUSD_ISSUER",
  "AGENTCORE_MARKET_XRPL_ENDPOINT",
].sort()), "Lambda environment contract changed");
assert(lambdaFunction.Properties.Environment.Variables.AGENTCORE_MARKET_XRPL_ENDPOINT === "https://s.altnet.rippletest.net:51234/", "Lambda RPC endpoint must remain exact XRPL Testnet");
assert(lambdaFunction.Properties.Environment.Variables.AGENTCORE_LAMBDA_GATEWAY_ID["Fn::If"][0] === "TargetConfigured" && lambdaFunction.Properties.Environment.Variables.AGENTCORE_LAMBDA_TARGET_ID["Fn::If"][0] === "TargetConfigured", "Lambda identity binding must remain absent during bootstrap");
assert(lambdaLogGroup.DeletionPolicy === "Retain" && lambdaLogGroup.UpdateReplacePolicy === "Retain" && lambdaLogGroup.Properties.DeletionProtectionEnabled === true, "Lambda log group must be retained and deletion-protected");
assert(lambdaLogGroup.Properties.RetentionInDays.Ref === "LambdaLogRetentionDays", "Lambda log retention must require explicit approval");
const lambdaAllowActions = lambdaRole.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .filter((statement) => statement.Effect === "Allow")
  .flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
assert(JSON.stringify(lambdaAllowActions) === JSON.stringify(["logs:CreateLogStream", "logs:PutLogEvents"]), "Lambda execution role must remain logs-only");
const lambdaLogStatement = lambdaRole.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .find((statement) => statement.Effect === "Allow" && Array.isArray(statement.Action) && statement.Action.includes("logs:PutLogEvents"));
assert(lambdaLogStatement?.Resource?.["Fn::Sub"] === "arn:${AWS::Partition}:logs:${AWS::Region}:${AWS::AccountId}:log-group:/aws/lambda/${TargetLambdaFunctionName}:log-stream:*", "Lambda log-stream permission must use the exact same-account ARN");
const lambdaDenyActions = lambdaRole.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .filter((statement) => statement.Effect === "Deny")
  .flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
for (const action of ["iam:*", "kms:*", "secretsmanager:*", "dynamodb:*", "bedrock-agentcore:GetResourcePaymentToken"]) {
  assert(lambdaDenyActions.includes(action), `Lambda deny boundary lost ${action}`);
}
assert(lambdaTemplate.Resources.AcceptedFunctionVersion.Condition === "TargetConfigured" && lambdaTemplate.Resources.AcceptedFunctionAlias.Condition === "TargetConfigured", "Lambda accepted version/alias must not exist during bootstrap");
assert(lambdaTemplate.Resources.AcceptedFunctionVersion.Properties.CodeSha256?.Ref === "LambdaPackageSha256Base64", "Lambda accepted version must bind the reviewed package checksum");
assert(lambdaTemplate.Rules.PackageOwnerMustMatchDestinationAccount.Assertions[0].Assert["Fn::Equals"][1].Ref === "AWS::AccountId", "Lambda package owner declaration must match the destination account");

const sameAccountLambdaArn = "arn:${AWS::Partition}:lambda:${AWS::Region}:${AWS::AccountId}:function:${TargetLambdaFunctionName}";
const acceptedLambdaArn = `${sameAccountLambdaArn}:accepted`;
const sameAccountEcrArn = "arn:${AWS::Partition}:ecr:${AWS::Region}:${AWS::AccountId}:repository/${RuntimeEcrRepositoryName}";
const expectedTargetLambda = template.Resources.ResearchGatewayTarget.Properties.TargetConfiguration.Mcp.Lambda.LambdaArn["Fn::If"];
assert(JSON.stringify(expectedTargetLambda) === JSON.stringify(["UseAcceptedTargetAlias", { "Fn::Sub": acceptedLambdaArn }, { "Fn::Sub": sameAccountLambdaArn }]), "Gateway target Lambda must select only the same-account bootstrap function or accepted alias");

const target = template.Resources.ResearchGatewayTarget.Properties;
const tool = target.TargetConfiguration.Mcp.Lambda.ToolSchema.InlinePayload;
assert(target.CredentialProviderConfigurations[0].CredentialProviderType === "GATEWAY_IAM_ROLE", "Target must use the exact Gateway role");
assert(tool.length === 1 && tool[0].Name === "pilot.read_market_context", "Target must expose one exact read tool");
const targetInput = tool[0].InputSchema;
const exactExternalArguments = ["context", "requestId", "scopeDigest"];
assert(JSON.stringify([...targetInput.Required].sort()) === JSON.stringify(exactExternalArguments), "Target required arguments must expose only the privacy-bounded contract");
assert(JSON.stringify(Object.keys(targetInput.Properties).sort()) === JSON.stringify(exactExternalArguments), "Target properties must expose only the privacy-bounded contract");
assert(targetInput.Properties.scopeDigest.Type === "string", "Target must carry only an opaque scope digest");
assert(targetInput.Properties.context.Type === "object" && targetInput.Properties.context.Properties === undefined && targetInput.Properties.context.Required === undefined, "Target market context must carry no caller-controlled selectors");
for (const forbidden of ["scope", "owner", "tenantId", "network", "personalization", "prompt", "token", "key"]) {
  assert(!Object.hasOwn(targetInput.Properties, forbidden), `Target must not expose ${forbidden}`);
}

const roleActions = (logicalId) => template.Resources[logicalId].Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .filter((statement) => statement.Effect === "Allow")
  .flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
const allowedRuntimePrefixes = ["ecr:", "logs:", "cloudwatch:"];
for (const action of roleActions("RuntimeExecutionRole")) {
  assert(
    action === "bedrock-agentcore:GetResourceOauth2Token" ||
      action === "dynamodb:GetItem" ||
      action === "dynamodb:UpdateItem" ||
      allowedRuntimePrefixes.some((prefix) => action.startsWith(prefix)),
    `unexpected Runtime action ${action}`,
  );
}
const runtimeOauthStatement = template.Resources.RuntimeExecutionRole.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .find((statement) => statement.Effect === "Allow" && statement.Action === "bedrock-agentcore:GetResourceOauth2Token");
const exactRuntimeOauthResources = [
  "arn:${AWS::Partition}:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:workload-identity-directory/default",
  "arn:${AWS::Partition}:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:workload-identity-directory/default/workload-identity/${RuntimeWorkloadIdentityName}",
  "arn:${AWS::Partition}:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:token-vault/default",
  "arn:${AWS::Partition}:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:token-vault/default/oauth2-credential-provider/${RuntimeOauth2CredentialProviderName}"
];
assert(JSON.stringify(runtimeOauthStatement?.Resource?.map((resource) => resource["Fn::Sub"])) === JSON.stringify(exactRuntimeOauthResources), "Runtime OAuth retrieval must be scoped to one same-account workload and provider");
const runtimeDenyActions = template.Resources.RuntimeExecutionRole.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .filter((statement) => statement.Effect === "Deny")
  .flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
assert(runtimeDenyActions.includes("bedrock-agentcore:GetWorkloadAccessToken*"), "Runtime must not mint workload access tokens");
assert(!roleActions("RuntimeExecutionRole").some((action) => action.startsWith("bedrock-agentcore:GetWorkloadAccessToken")), "Runtime allow policy must not mint workload access tokens");
const gatewayAllows = roleActions("GatewayExecutionRole").filter((action) => !action.endsWith(":*"));
assert(gatewayAllows.length === 1 && gatewayAllows[0] === "lambda:InvokeFunction", "Gateway role authority changed");
const gatewayInvokeStatement = template.Resources.GatewayExecutionRole.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .find((statement) => statement.Effect === "Allow" && statement.Action === "lambda:InvokeFunction");
assert(JSON.stringify(gatewayInvokeStatement?.Resource?.["Fn::If"]) === JSON.stringify(["UseAcceptedTargetAlias", { "Fn::Sub": acceptedLambdaArn }, { "Fn::Sub": sameAccountLambdaArn }]), "Gateway invoke policy must select only the same-account bootstrap function or accepted alias");
const runtimeImageStatement = template.Resources.RuntimeExecutionRole.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .find((statement) => statement.Effect === "Allow" && Array.isArray(statement.Action) && statement.Action.includes("ecr:BatchGetImage"));
assert(runtimeImageStatement?.Resource?.["Fn::Sub"] === sameAccountEcrArn, "Runtime image policy must be derived in the stack account");
const replayTable = template.Resources.RuntimeReplayTable;
assert(replayTable?.Type === "AWS::DynamoDB::Table", "Runtime replay table is missing");
assert(replayTable.DeletionPolicy === "Retain" && replayTable.UpdateReplacePolicy === "Retain", "Runtime replay table must be retained by default");
assert(replayTable.Properties.BillingMode === "PAY_PER_REQUEST", "Runtime replay table must use bounded on-demand billing");
assert(replayTable.Properties.OnDemandThroughput.MaxReadRequestUnits.Ref === "ReplayMaxReadRequestUnits", "Replay read cap must require explicit approval");
assert(replayTable.Properties.OnDemandThroughput.MaxWriteRequestUnits.Ref === "ReplayMaxWriteRequestUnits", "Replay write cap must require explicit approval");
assert(JSON.stringify(replayTable.Properties.KeySchema) === JSON.stringify([{ AttributeName: "namespace", KeyType: "HASH" }, { AttributeName: "requestDigest", KeyType: "RANGE" }]), "Runtime replay key schema changed");
assert(replayTable.Properties.TimeToLiveSpecification.AttributeName === "expiresAt" && replayTable.Properties.TimeToLiveSpecification.Enabled === true, "Runtime replay TTL must use expiresAt");
assert(replayTable.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled === true, "Runtime replay PITR must remain enabled");
assert(replayTable.Properties.DeletionProtectionEnabled === true, "Runtime replay deletion protection must remain enabled");
assert(replayTable.Properties.SSESpecification === undefined, "Runtime replay must use DynamoDB default AWS-owned encryption without customer KMS authority or charges");
assert(replayTable.Properties.GlobalSecondaryIndexes === undefined && replayTable.Properties.LocalSecondaryIndexes === undefined && replayTable.Properties.StreamSpecification === undefined, "Runtime replay must not add indexes or streams");
const replayStatement = template.Resources.RuntimeExecutionRole.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .find((statement) => Array.isArray(statement.Action) && statement.Action.includes("dynamodb:GetItem"));
assert(JSON.stringify(replayStatement?.Action) === JSON.stringify(["dynamodb:GetItem", "dynamodb:UpdateItem"]), "Runtime replay IAM actions changed");
assert(JSON.stringify(replayStatement?.Resource) === JSON.stringify({ "Fn::GetAtt": ["RuntimeReplayTable", "Arn"] }), "Runtime replay IAM must target only the exact table");
const callerAllows = caller.Resources.PilotCallerRole.Properties.Policies
  .flatMap((policy) => policy.PolicyDocument.Statement)
  .filter((statement) => statement.Effect === "Allow")
  .flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
assert(callerAllows.length === 1 && callerAllows[0] === "bedrock-agentcore:InvokeAgentRuntime", "Pilot caller authority changed");
assert(caller.Parameters.PilotCallerPrincipalArn === undefined, "Caller stack must not accept an arbitrary principal ARN");
assert(caller.Parameters.RuntimeArn === undefined, "Caller stack must not accept an arbitrary Runtime ARN");
assert(caller.Parameters.PilotCallerRoleName.AllowedPattern === "^[A-Za-z0-9+=,.@_-]{1,64}$", "Pilot caller role name boundary changed");
assert(caller.Parameters.RuntimeId.AllowedPattern === "^[A-Za-z][A-Za-z0-9_]{0,99}-[A-Za-z0-9]{10}$", "Pilot caller Runtime ID boundary changed");
const callerPrincipal = caller.Resources.PilotCallerRole.Properties.AssumeRolePolicyDocument.Statement[0].Principal.AWS["Fn::Sub"];
assert(callerPrincipal === "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/${PilotCallerRoleName}", "Pilot caller principal must be one named same-account role");
const callerRuntimeResource = caller.Resources.PilotCallerRole.Properties.Policies[0].PolicyDocument.Statement[0].Resource["Fn::Sub"];
assert(callerRuntimeResource === "arn:${AWS::Partition}:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:runtime/${RuntimeId}", "Pilot caller Runtime must be one exact same-account Runtime");

const createInput = example.createInput;
const verification = example.postCreateVerification;
const updateInput = updateExample.updateInput;
assert(template.Parameters.JwtTenantClaimName.Default === verification.jwtVerification.tenantClaimName, "Gateway and Runtime JWT tenant claim names differ");
assert(template.Parameters.JwtDeploymentTenantId.Default === undefined, "Gateway deployment tenant must be an explicit stack input");
assert(new RegExp(template.Parameters.JwtDeploymentTenantId.AllowedPattern).test(verification.jwtVerification.deploymentTenantId), "Runtime deployment tenant is not valid for the Gateway parameter");
const createEnvironmentSchema = schema.properties.createInput.properties.environmentVariables;
const updateEnvironmentSchema = updateSchema.properties.updateInput.properties.environmentVariables;
assert(createEnvironmentSchema.additionalProperties === false && updateEnvironmentSchema.additionalProperties === false, "Runtime environment schemas must reject additional values, including static tokens");
assert(JSON.stringify([...createEnvironmentSchema.required].sort()) === JSON.stringify(runtimeEnvironmentKeys), "Runtime create schema environment inventory drifted");
assert(JSON.stringify([...updateEnvironmentSchema.required].sort()) === JSON.stringify(runtimeEnvironmentKeys), "Runtime update schema environment inventory drifted");
assert(JSON.stringify(Object.keys(createEnvironmentSchema.properties).sort()) === JSON.stringify(runtimeEnvironmentKeys), "Runtime create environment schema exposes an unexpected field");
assert(JSON.stringify(Object.keys(updateEnvironmentSchema.properties).sort()) === JSON.stringify(runtimeEnvironmentKeys), "Runtime update environment schema exposes an unexpected field");
assert(schema.properties.region.enum.includes(example.region), "Runtime create Region violates the contract");
assert(updateSchema.properties.region.enum.includes(updateExample.region), "Runtime update Region violates the contract");
assert(schema.properties.destinationAccountId.pattern === "^[0-9]{12}$", "Runtime create destination account boundary changed");
assert(updateSchema.properties.destinationAccountId.pattern === "^[0-9]{12}$", "Runtime update destination account boundary changed");
assert(!Object.hasOwn(createInput, "metadataConfiguration"), "CreateAgentRuntime input must not contain unsupported metadataConfiguration");
assert(schema.properties.createInput.properties.metadataConfiguration === undefined, "CreateAgentRuntime schema must not expose unsupported metadataConfiguration");
assert(schema.properties.createInput.properties.requestHeaderConfiguration === undefined && updateSchema.properties.updateInput.properties.requestHeaderConfiguration === undefined, "Runtime schemas must not expose Authorization header forwarding");
assert(schema.properties.createInput.required.includes("authorizerConfiguration") && updateSchema.properties.updateInput.required.includes("authorizerConfiguration"), "Runtime create and update must require CUSTOM_JWT authorization");
assert(schema.properties.createInput.properties.protocolConfiguration.properties.serverProtocol.const === createInput.protocolConfiguration.serverProtocol, "Runtime protocol violates the create contract");
assert(updateInput.metadataConfiguration.requireMMDSV2 === true, "Runtime update must require MMDSv2");
assert(updateSchema.properties.updateInput.properties.metadataConfiguration.properties.requireMMDSV2.const === true, "Runtime update schema must fail closed on MMDSv2");
assert(schema.properties.postCreateVerification.properties.gateway.properties.protocolVersion.const === verification.gateway.protocolVersion, "Gateway protocol violates the contract");
assert(new RegExp(schema.properties.createInput.properties.agentRuntimeName.pattern).test(createInput.agentRuntimeName), "Runtime name fixture is invalid");
assert(new RegExp(schema.properties.createInput.properties.agentRuntimeArtifact.properties.containerConfiguration.properties.containerUri.pattern).test(createInput.agentRuntimeArtifact.containerConfiguration.containerUri), "Runtime image fixture is invalid");
assert(new RegExp(schema.properties.createInput.properties.roleArn.pattern).test(createInput.roleArn), "Runtime role fixture is invalid");
assert(new RegExp(updateSchema.properties.agentRuntimeId.pattern).test(updateExample.agentRuntimeId), "Runtime update ID fixture is invalid");
assert(JSON.stringify(updateInput.agentRuntimeArtifact) === JSON.stringify(createInput.agentRuntimeArtifact), "Runtime update must preserve the pinned create artifact");
assert(updateInput.roleArn === createInput.roleArn, "Runtime update must preserve the create role");
assert(JSON.stringify(updateInput.authorizerConfiguration) === JSON.stringify(createInput.authorizerConfiguration), "Runtime update must preserve the create authorizer");
assert(JSON.stringify(updateInput.protocolConfiguration) === JSON.stringify(createInput.protocolConfiguration), "Runtime update must preserve the create protocol");
assert(JSON.stringify(updateInput.networkConfiguration) === JSON.stringify(createInput.networkConfiguration), "Runtime update must preserve the create network configuration");
assert(new RegExp(schema.properties.postCreateVerification.properties.gateway.properties.url.pattern).test(verification.gateway.url), "Gateway URL fixture is invalid");
assert(new RegExp(schema.properties.postCreateVerification.properties.gateway.properties.toolName.pattern).test(verification.gateway.toolName), "Gateway tool fixture is invalid");
assert(verification.jwtVerification.allowedScope === "pilot.read_market_context", "JWT scope fixture is invalid");
assert(verification.jwtVerification.deploymentTenantId === "pilot-agentcore-event-workload", "JWT deployment tenant fixture is invalid");
assert(verification.jwtVerification.deploymentTenantId !== "wallet", "JWT deployment tenant must not be derived from a wallet tenant");
validateRuntimeAccountBinding(example, updateExample, "repository Runtime examples");

const missingRuntimeAuthorizerCreate = clone(example);
delete missingRuntimeAuthorizerCreate.createInput.authorizerConfiguration;
expectFailure(
  () => validateRuntimeAccountBinding(missingRuntimeAuthorizerCreate, updateExample, "missing Runtime authorizer regression"),
  "missing required property authorizerConfiguration",
  "Runtime schema must reject a missing inbound authorizer",
);

const driftedRuntimeAuthorizerUpdate = clone(updateExample);
driftedRuntimeAuthorizerUpdate.updateInput.authorizerConfiguration.customJWTAuthorizer.allowedClients = ["other-client"];
expectFailure(
  () => validateRuntimeAccountBinding(example, driftedRuntimeAuthorizerUpdate, "Runtime authorizer drift regression"),
  "update must preserve the complete create Runtime authorizer",
  "Runtime validator must reject create/update authorizer drift",
);

const reusedRuntimeAudienceCreate = clone(example);
const reusedRuntimeAudienceUpdate = clone(updateExample);
const gatewayAudience = reusedRuntimeAudienceCreate.postCreateVerification.jwtVerification.audience;
reusedRuntimeAudienceCreate.createInput.authorizerConfiguration.customJWTAuthorizer.allowedAudience = [gatewayAudience];
reusedRuntimeAudienceUpdate.updateInput.authorizerConfiguration.customJWTAuthorizer.allowedAudience = [gatewayAudience];
reusedRuntimeAudienceCreate.postCreateVerification.runtimeInboundJwt.audience = gatewayAudience;
expectFailure(
  () => validateRuntimeAccountBinding(reusedRuntimeAudienceCreate, reusedRuntimeAudienceUpdate, "Runtime token reuse regression"),
  "Runtime and Gateway JWT audiences must be distinct",
  "Runtime validator must reject reuse of the outbound Gateway token audience",
);

const forwardedAuthorizationCreate = clone(example);
const forwardedAuthorizationUpdate = clone(updateExample);
forwardedAuthorizationCreate.createInput.requestHeaderConfiguration = { requestHeaderAllowlist: ["Authorization"] };
forwardedAuthorizationUpdate.updateInput.requestHeaderConfiguration = { requestHeaderAllowlist: ["Authorization"] };
expectFailure(
  () => validateRuntimeAccountBinding(forwardedAuthorizationCreate, forwardedAuthorizationUpdate, "Authorization forwarding regression"),
  "unexpected property requestHeaderConfiguration",
  "Runtime schema must reject Authorization header forwarding",
);

const staticTokenCreate = clone(example);
const staticTokenUpdate = clone(updateExample);
staticTokenCreate.createInput.environmentVariables.AGENTCORE_GATEWAY_BEARER_TOKEN = "forbidden-static-token";
staticTokenUpdate.updateInput.environmentVariables.AGENTCORE_GATEWAY_BEARER_TOKEN = "forbidden-static-token";
expectFailure(
  () => validateRuntimeAccountBinding(staticTokenCreate, staticTokenUpdate, "static-token regression"),
  "unexpected property AGENTCORE_GATEWAY_BEARER_TOKEN",
  "Runtime schema must reject static token environment variables",
);

for (const [name, extraValue, expected] of [
  ["AGENTCORE_GATEWAY_JWT_ALLOWED_SUBJECTS_JSON", "other-runtime", "JWT subjects: list length is invalid"],
  ["AGENTCORE_GATEWAY_JWT_ALLOWED_CLIENTS_JSON", "other-client", "JWT clients: list length is invalid"],
]) {
  const multiPrincipalCreate = clone(example);
  const multiPrincipalUpdate = clone(updateExample);
  for (const document of [multiPrincipalCreate.createInput, multiPrincipalUpdate.updateInput]) {
    const values = JSON.parse(document.environmentVariables[name]);
    values.push(extraValue);
    document.environmentVariables[name] = JSON.stringify(values);
  }
  expectFailure(
    () => validateRuntimeAccountBinding(
      multiPrincipalCreate,
      multiPrincipalUpdate,
      `${name} singleton regression`,
    ),
    expected,
    `Runtime validator must reject multiple principals in ${name}`,
  );
}

const crossAccountCreate = clone(example);
const crossAccountUpdate = clone(updateExample);
crossAccountCreate.createInput.agentRuntimeArtifact.containerConfiguration.containerUri = crossAccountCreate.createInput.agentRuntimeArtifact.containerConfiguration.containerUri.replace(/^000000000000/, "111111111111");
crossAccountUpdate.updateInput.agentRuntimeArtifact.containerConfiguration.containerUri = crossAccountUpdate.updateInput.agentRuntimeArtifact.containerConfiguration.containerUri.replace(/^000000000000/, "111111111111");
expectFailure(
  () => validateRuntimeAccountBinding(crossAccountCreate, crossAccountUpdate, "cross-account regression"),
  "ECR image is not in the destination account",
  "Runtime validator must reject a cross-account image",
);

const crossRegionCreate = clone(example);
const crossRegionUpdate = clone(updateExample);
crossRegionCreate.createInput.agentRuntimeArtifact.containerConfiguration.containerUri = crossRegionCreate.createInput.agentRuntimeArtifact.containerConfiguration.containerUri.replace("us-east-2", "us-east-1");
crossRegionUpdate.updateInput.agentRuntimeArtifact.containerConfiguration.containerUri = crossRegionUpdate.updateInput.agentRuntimeArtifact.containerConfiguration.containerUri.replace("us-east-2", "us-east-1");
expectFailure(
  () => validateRuntimeAccountBinding(crossRegionCreate, crossRegionUpdate, "cross-region ECR regression"),
  "ECR image is not in the selected Region",
  "Runtime validator must reject a cross-Region image",
);

const crossRegionGatewayCreate = clone(example);
const crossRegionGatewayUpdate = clone(updateExample);
crossRegionGatewayCreate.createInput.environmentVariables.AGENTCORE_GATEWAY_URL = crossRegionGatewayCreate.createInput.environmentVariables.AGENTCORE_GATEWAY_URL.replace("us-east-2", "us-east-1");
crossRegionGatewayUpdate.updateInput.environmentVariables.AGENTCORE_GATEWAY_URL = crossRegionGatewayUpdate.updateInput.environmentVariables.AGENTCORE_GATEWAY_URL.replace("us-east-2", "us-east-1");
crossRegionGatewayCreate.postCreateVerification.gateway.url = crossRegionGatewayCreate.postCreateVerification.gateway.url.replace("us-east-2", "us-east-1");
expectFailure(
  () => validateRuntimeAccountBinding(crossRegionGatewayCreate, crossRegionGatewayUpdate, "cross-region Gateway regression"),
  "Gateway URL is not in the selected Region",
  "Runtime validator must reject a cross-Region Gateway",
);

const invalidRetentionCreate = clone(example);
const invalidRetentionUpdate = clone(updateExample);
invalidRetentionCreate.createInput.environmentVariables.AGENTCORE_REPLAY_LEASE_MS = "60000";
invalidRetentionUpdate.updateInput.environmentVariables.AGENTCORE_REPLAY_LEASE_MS = "60000";
invalidRetentionCreate.createInput.environmentVariables.AGENTCORE_REPLAY_RETENTION_MS = "60000";
invalidRetentionUpdate.updateInput.environmentVariables.AGENTCORE_REPLAY_RETENTION_MS = "60000";
expectFailure(
  () => validateRuntimeAccountBinding(invalidRetentionCreate, invalidRetentionUpdate, "replay-retention regression"),
  "replay retention must exceed its lease",
  "Runtime validator must reject non-increasing replay retention",
);

const operatorActions = operator.Statement.flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action]);
assert(operatorActions.includes("iam:PassRole"), "Operator policy must keep PassRole explicit");
assert(operator.Statement.filter((statement) => statement.Action === "bedrock-agentcore:CreateAgentRuntime" || statement.Action === "bedrock-agentcore:CreateGateway").every((statement) => statement.Resource === "*" && statement.Condition?.["ForAllValues:StringEquals"]?.["aws:TagKeys"]?.length === 4), "Create actions must use supported wildcard resources and exact request tags");
assert(!operatorActions.some((action) => action === "iam:*" || action.startsWith("iam:Create") || action.startsWith("iam:Delete")), "Operator policy must not manage IAM identities");
assert(operatorActions.includes("kms:*") && operator.Statement.some((statement) => statement.Effect === "Deny" && (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes("kms:*")), "Operator policy must explicitly deny KMS management");

const suppliedRuntimeInputs = process.argv.slice(2);
assert(suppliedRuntimeInputs.length === 0 || suppliedRuntimeInputs.length === 2, "usage: node infra/agentcore/validate.mjs [runtime-create.json runtime-update.json]");
if (suppliedRuntimeInputs.length === 2) {
  const [suppliedCreate, suppliedUpdate] = await Promise.all(suppliedRuntimeInputs.map(readJsonPath));
  validateRuntimeAccountBinding(suppliedCreate, suppliedUpdate, "supplied Runtime inputs");
}

process.stdout.write(`PASS ${root}: AgentCore account-neutral templates and Runtime account bindings are internally consistent\n`);
