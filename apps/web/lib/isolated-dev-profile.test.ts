import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import nextConfig from "../next.config";

const webPackage = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, unknown> };
const rootPackage = JSON.parse(
  readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, unknown> };

describe("isolated local-wallet development command", () => {
  it("pins the public marker and page/HMR listener to the reviewed slot", () => {
    expect(webPackage.scripts?.["dev:isolated"]).toBe(
      "node ../../scripts/dev-pilot-isolated-v1.mjs",
    );
    expect(rootPackage.scripts?.["dev:isolated"]).toBe(
      "node scripts/dev-pilot-isolated-v1.mjs",
    );
    expect(nextConfig.allowedDevOrigins).toEqual(["127.0.0.2"]);
  });

  it("contains no wildcard, variable host, fallback host, or alternate port", () => {
    const command = String(rootPackage.scripts?.["dev:isolated"]);
    expect(command).not.toMatch(/0\.0\.0\.0|localhost|\[::|--hostname\s+\$|--port\s+\$/);
    expect(command).not.toContain("||");
  });
});
