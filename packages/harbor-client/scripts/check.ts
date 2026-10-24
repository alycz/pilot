import assert from "node:assert/strict";

import {
  createHarborMcpClient,
  createHarborRestClient,
} from "../src/index.js";

const harborUrl = process.env.HARBOR_URL?.trim();
const useLiveHarbor = Boolean(harborUrl) && process.env.HARBOR_MOCK !== "1";
const config = useLiveHarbor
  ? {
      apiKey: process.env.HARBOR_API_KEY,
      baseUrl: harborUrl,
      mock: false,
    }
  : { mock: true };

const rest = createHarborRestClient(config);
const mcp = createHarborMcpClient({ ...config, restClient: rest });

try {
  const restResult = await rest.op("venues.list", {});
  const mcpResult = await mcp.execute(
    "return await harbor.venues.list({})",
  );

  console.log("REST venues.list");
  console.log(JSON.stringify(restResult, null, 2));
  console.log("MCP venues.list");
  console.log(JSON.stringify(mcpResult, null, 2));

  assert.deepStrictEqual(
    mcpResult,
    restResult,
    "REST and MCP venues.list results differ",
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await mcp.close();
}
