import { describe, expect, it, vi } from "vitest";

import { createIdentityGatewayAuth } from "../src/identity";

const request = {
  providerName: "pilot-market-data",
  flow: "M2M" as const,
  allowedScopes: ["market.read"],
  scopeDigest: "a".repeat(64),
};

describe("AgentCore Identity seam", () => {
  it("passes short-lived authorization only to the Gateway transport", async () => {
    const resolve = vi.fn(async () => ({
      status: "authorized" as const,
      authorization: "Bearer short-lived-test-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    const auth = createIdentityGatewayAuth({ resolve }, request);
    await expect(auth.authorization()).resolves.toBe("Bearer short-lived-test-token");
    expect(resolve).toHaveBeenCalledWith(request, { signal: undefined });
  });

  it("fails closed when a grant is absent or stale", async () => {
    const required = createIdentityGatewayAuth({
      async resolve() {
        return { status: "authorization_required", providerName: request.providerName, allowedScopes: request.allowedScopes };
      },
    }, request);
    await expect(required.authorization()).rejects.toThrow("authorization is required");

    const stale = createIdentityGatewayAuth({
      async resolve() {
        return { status: "authorized", authorization: "Bearer stale", expiresAt: "2020-01-01T00:00:00.000Z" };
      },
    }, request);
    await expect(stale.authorization()).rejects.toThrow("expired");
  });

  it("redacts resolver failures", async () => {
    const auth = createIdentityGatewayAuth({
      async resolve() { throw new Error("Bearer must-not-leak"); },
    }, request);
    const error = await auth.authorization().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: AgentCore Identity authorization is unavailable");
    expect(String(error)).not.toContain("must-not-leak");
  });
});
