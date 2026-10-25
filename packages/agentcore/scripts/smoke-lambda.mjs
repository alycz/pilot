import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const gatewayId = "PilotResearchGateway-AbCdEf1234";
const targetId = "PilotReadTarget-ZyXwVu9876";
const targetName = "PilotReadTarget";
const hash = "A".repeat(64);
const closeTime = Math.floor(Date.now() / 1_000) - 946_684_800 - 5;
let callCount = 0;

Object.assign(process.env, {
  AGENTCORE_LAMBDA_GATEWAY_ID: gatewayId,
  AGENTCORE_LAMBDA_TARGET_ID: targetId,
  AGENTCORE_LAMBDA_TARGET_NAME: targetName,
  AGENTCORE_MARKET_RLUSD_ISSUER: "rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV",
  AGENTCORE_MARKET_XRPL_ENDPOINT: "https://s.altnet.rippletest.net:51234/",
  AGENTCORE_MARKET_MAX_LEDGER_AGE_SECONDS: "120",
});

globalThis.fetch = async (_url, init) => {
  callCount += 1;
  const request = JSON.parse(String(init?.body));
  assert.equal(init?.redirect, "error");
  assert.equal(init?.headers?.authorization, undefined);
  const result = request.method === "ledger" ? {
    closed: true,
    ledger: {
      close_time: closeTime,
      close_time_resolution: 10,
      closed: true,
      ledger_hash: hash,
      ledger_index: 12_345,
    },
    ledger_hash: hash,
    ledger_index: 12_345,
    validated: true,
  } : {
    ledger_hash: hash,
    ledger_index: 12_345,
    offers: [],
  };
  return new Response(JSON.stringify({ result, status: "success" }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
};

const artifactRoot = resolve(import.meta.dirname, "../dist/lambda");
const artifactPath = resolve(artifactRoot, "lambda-entry.mjs");
const manifest = JSON.parse(await readFile(resolve(artifactRoot, "manifest.json"), "utf8"));
const bundle = await readFile(artifactPath);
const notices = await readFile(resolve(artifactRoot, "THIRD_PARTY_NOTICES.txt"));
assert.equal(createHash("sha256").update(bundle).digest("hex"), manifest.sha256);
assert.equal(createHash("sha256").update(notices).digest("hex"), manifest.thirdPartyNotices.sha256);
assert.deepEqual(manifest.bundledPackages, [{ license: "MIT", name: "zod", version: "4.6.7" }]);
assert.match(notices.toString("utf8"), /Package: zod 4\.6\.7[\s\S]*MIT License/u);

const artifact = pathToFileURL(artifactPath);
const { handler } = await import(artifact.href);
assert.equal(typeof handler, "function");

const response = await handler({
  context: {},
  requestId: "package-smoke-1",
  scopeDigest: "a".repeat(64),
}, {
  clientContext: { custom: {
    bedrockAgentCoreAwsRequestId: "aws-request-smoke",
    bedrockAgentCoreGatewayId: gatewayId,
    bedrockAgentCoreMcpMessageId: "mcp-message-smoke",
    bedrockAgentCoreMessageVersion: "1.0",
    bedrockAgentCoreTargetId: targetId,
    bedrockAgentCoreToolName: `${targetName}___pilot.read_market_context`,
  } },
});

assert.equal(callCount, 2);
assert.match(response.summary, /0 ask-side XRP\/RLUSD offers/u);
assert.equal(response.evidence[0].source, "xrpl-testnet-dex");
process.stdout.write("AgentCore Lambda bundle smoke passed\n");
