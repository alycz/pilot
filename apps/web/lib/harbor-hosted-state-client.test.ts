import { describe, expect, it, vi } from "vitest";

import {
  HarborHostedStateClientError,
  createHarborHostedStateClientFromEnv,
  isHarborHostedStateConfigured,
} from "./harbor-hosted-state-client";

const KEY = `pilot-hosted-state:${"K".repeat(32)}`;
const HEX = "a".repeat(64);
const OTHER_HEX = "b".repeat(64);
const MAX_PERSONALIZATION_CIPHERTEXT_CHARS = 1_398_358;
const ENV = {
  HARBOR_URL: "https://harbor.example",
  PILOT_DEPLOYMENT_PROFILE: "hosted",
  PILOT_HOSTED_STATE_API_KEY: KEY,
} as const;

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function proofInput(namespace: "chat" | "wallet-auth" | "near-wallet-auth" = "wallet-auth") {
  return {
    version: 1 as const, namespace, scopeId: HEX,
    nonceDigest: OTHER_HEX, expiresAtMs: 1_800_000_000_000,
  };
}

function quotaInput() {
  return {
    version: 1 as const,
    requestId: "12345678-1234-4123-8123-123456789abc",
    accountScopeId: HEX, sessionScopeId: OTHER_HEX, network: "testnet" as const,
    sessionExpiresAtMs: 1_800_000_000_000, policyVersion: "research-v1",
    accountMaximum: 8, sessionMaximum: 4,
  };
}

describe("Harbor hosted-state client boundary", () => {
  it("accepts exact hosted HTTPS and loopback development origins with a dedicated key", () => {
    expect(isHarborHostedStateConfigured(ENV)).toBe(true);
    expect(isHarborHostedStateConfigured({ HARBOR_URL: "http://127.0.0.1:8791",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet", PILOT_HOSTED_STATE_API_KEY: KEY })).toBe(true);
    expect(isHarborHostedStateConfigured({ HARBOR_URL: "http://[::1]:8791",
      PILOT_DEPLOYMENT_PROFILE: "local-wallet", PILOT_HOSTED_STATE_API_KEY: KEY })).toBe(true);
  });

  it.each([
    { ...ENV, HARBOR_URL: "http://harbor.example" },
    { ...ENV, HARBOR_URL: "https://127.0.0.1:8791" },
    { ...ENV, HARBOR_URL: "https://harbor.example/base" },
    { ...ENV, HARBOR_URL: "https://user@harbor.example" },
    { ...ENV, HARBOR_URL: "https://harbor.example?next=attacker" },
    { ...ENV, PILOT_HOSTED_STATE_API_KEY: undefined },
    { ...ENV, PILOT_HOSTED_STATE_API_KEY: "pilot:short" },
    { ...ENV, HARBOR_API_KEY: KEY },
    { ...ENV, HARBOR_API_KEY: `other:${"K".repeat(32)}` },
    { ...ENV, HARBOR_API_KEY: `pilot-hosted-state:${"B".repeat(32)}` },
    { ...ENV, HARBOR_API_KEY: "malformed-broad-key" },
    { ...ENV, HARBOR_API_KEY: ` broad:${"B".repeat(32)}` },
    { ...ENV, PILOT_HOSTED_STATE_API_KEY: `bad principal:${"K".repeat(32)}` },
    { ...ENV, PILOT_HOSTED_STATE_API_KEY: `pilot-hosted-state:${"!".repeat(32)}` },
    { HARBOR_URL: "https://harbor.example", PILOT_DEPLOYMENT_PROFILE: "hosted", HARBOR_API_KEY: KEY },
    { HARBOR_URL: "http://localhost:8791", PILOT_DEPLOYMENT_PROFILE: "local-wallet",
      PILOT_HOSTED_STATE_API_KEY: KEY },
  ])("rejects an unsafe or incomplete state boundary %#", (environment) => {
    expect(isHarborHostedStateConfigured(environment)).toBe(false);
    expect(() => createHarborHostedStateClientFromEnv(environment)).toThrow(
      "Hosted Pilot state is unavailable.",
    );
  });

  it("accepts distinct named principals only when their tokens are also distinct", () => {
    expect(isHarborHostedStateConfigured({
      ...ENV,
      HARBOR_API_KEY: `pilot-general:${"B".repeat(32)}`,
    })).toBe(true);
  });

  it("uses the fixed proof endpoint, dedicated bearer and exact request", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ consumed: true }));
    const client = createHarborHostedStateClientFromEnv(ENV, { fetch: fetchMock });
    await expect(client.consumeWalletProof(proofInput())).resolves.toEqual({ consumed: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://harbor.example/internal/pilot-state/v1/wallet-proofs/consume");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(init?.body))).toEqual(proofInput());
  });

  it("accepts the exact domain-separated NEAR wallet-auth namespace", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ consumed: true }));
    const client = createHarborHostedStateClientFromEnv(ENV, { fetch: fetchMock });
    await expect(client.consumeWalletProof(proofInput("near-wallet-auth")))
      .resolves.toEqual({ consumed: true });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual(
      proofInput("near-wallet-auth"),
    );
  });

  it("never retries an uncertain proof consume", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(`lost ${KEY}`));
    const client = createHarborHostedStateClientFromEnv(ENV, { fetch: fetchMock });
    await expect(client.consumeWalletProof(proofInput())).rejects.toMatchObject({
      code: "HOSTED_STATE_TRANSPORT_UNCERTAIN", status: 503,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries one byte-identical quota reservation after transport uncertainty", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("lost response"))
      .mockResolvedValueOnce(json({ reserved: true, idempotent: true,
        policyVersion: "research-v1", windowExpiresAtMs: 1_800_003_600_000,
        remainingAccountRuns: 7, remainingSessionRuns: 3 }));
    const client = createHarborHostedStateClientFromEnv(ENV, { fetch: fetchMock });
    await expect(client.reserveResearchQuota(quotaInput())).resolves.toMatchObject({
      reserved: true, idempotent: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1]?.body).toBe(fetchMock.mock.calls[1]![1]?.body);
  });

  it("strictly validates personalization responses and supports compare-and-swap", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ ciphertext: "sealed", contentDigest: HEX }))
      .mockResolvedValueOnce(json({ swapped: true }));
    const client = createHarborHostedStateClientFromEnv(ENV, { fetch: fetchMock });
    await expect(client.readPersonalization({ version: 1, scopeId: HEX, resource: "preferences" }))
      .resolves.toEqual({ ciphertext: "sealed", contentDigest: HEX });
    await expect(client.compareAndSwapPersonalization({ version: 1, scopeId: HEX,
      resource: "workflow-lessons", expectedDigest: null, contentDigest: OTHER_HEX,
      ciphertext: "sealed-v2" })).resolves.toEqual({ swapped: true });

    const malformed = createHarborHostedStateClientFromEnv(ENV, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json({
        ciphertext: null, contentDigest: HEX, extra: true,
      })),
    });
    await expect(malformed.readPersonalization({ version: 1, scopeId: HEX,
      resource: "preferences" })).rejects.toMatchObject({ code: "HOSTED_STATE_UNAVAILABLE" });
  });

  it("supports strict physical personalization deletion and reports CAS conflict as false", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ deleted: true }))
      .mockResolvedValueOnce(json({ deleted: false }));
    const client = createHarborHostedStateClientFromEnv(ENV, { fetch: fetchMock });
    const input = {
      version: 1 as const, scopeId: HEX, resource: "preferences" as const,
      expectedDigest: OTHER_HEX,
    };
    await expect(client.deletePersonalization(input)).resolves.toEqual({ deleted: true });
    await expect(client.deletePersonalization(input)).resolves.toEqual({ deleted: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://harbor.example/internal/pilot-state/v1/personalization/delete");
    expect(JSON.parse(String(init?.body))).toEqual(input);

    await expect(client.deletePersonalization({
      ...input, expectedDigest: OTHER_HEX.toUpperCase(),
    })).rejects.toMatchObject({ code: "HOSTED_STATE_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed personalization deletion responses", async () => {
    for (const body of [
      {},
      { deleted: "true" },
      { deleted: false, extra: true },
    ]) {
      const client = createHarborHostedStateClientFromEnv(ENV, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(json(body)),
      });
      await expect(client.deletePersonalization({
        version: 1, scopeId: HEX, resource: "workflow-lessons", expectedDigest: OTHER_HEX,
      })).rejects.toMatchObject({ code: "HOSTED_STATE_UNAVAILABLE" });
    }
  });

  it("accepts the complete bounded envelope for one MiB plaintext and rejects one extra byte", async () => {
    const maximumCiphertext = "x".repeat(MAX_PERSONALIZATION_CIPHERTEXT_CHARS);
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ swapped: true }))
      .mockResolvedValueOnce(json({ ciphertext: maximumCiphertext, contentDigest: HEX }));
    const client = createHarborHostedStateClientFromEnv(ENV, { fetch: fetchMock });
    await expect(client.compareAndSwapPersonalization({
      version: 1, scopeId: HEX, resource: "preferences", expectedDigest: null,
      contentDigest: OTHER_HEX, ciphertext: maximumCiphertext,
    })).resolves.toEqual({ swapped: true });
    await expect(client.readPersonalization({
      version: 1, scopeId: HEX, resource: "preferences",
    })).resolves.toEqual({ ciphertext: maximumCiphertext, contentDigest: HEX });

    await expect(client.compareAndSwapPersonalization({
      version: 1, scopeId: HEX, resource: "preferences", expectedDigest: null,
      contentDigest: OTHER_HEX, ciphertext: `${maximumCiphertext}x`,
    })).rejects.toMatchObject({ code: "HOSTED_STATE_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const oversizedResponse = createHarborHostedStateClientFromEnv(ENV, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json({
        ciphertext: `${maximumCiphertext}x`, contentDigest: HEX,
      })),
    });
    await expect(oversizedResponse.readPersonalization({
      version: 1, scopeId: HEX, resource: "preferences",
    })).rejects.toMatchObject({ code: "HOSTED_STATE_UNAVAILABLE" });
  });

  it("rejects redirects, oversized bodies, wrong content types and malformed errors", async () => {
    const redirected = json({ consumed: true });
    Object.defineProperty(redirected, "redirected", { value: true });
    for (const response of [redirected, new Response("ok", { headers: { "content-type": "text/plain" } }),
      json({ consumed: true }, { headers: { "content-length": "1410001" } }),
      json({ error: { code: "BAD", message: "x", secret: KEY } }, { status: 503 })]) {
      const client = createHarborHostedStateClientFromEnv(ENV, {
        fetch: vi.fn<typeof fetch>().mockResolvedValue(response),
      });
      await expect(client.consumeWalletProof(proofInput())).rejects.toEqual(
        expect.objectContaining({ code: "HOSTED_STATE_UNAVAILABLE",
          message: "Hosted Pilot state is unavailable." }),
      );
    }
  });

  it("exposes only a bounded remote code/status/retry hint", async () => {
    const client = createHarborHostedStateClientFromEnv(ENV, {
      fetch: vi.fn<typeof fetch>().mockResolvedValue(json({ error: {
        code: "QUOTA_EXHAUSTED", message: `private ${KEY}`, retryAfterSeconds: 30,
      } }, { status: 429 })),
    });
    const result = client.reserveResearchQuota(quotaInput());
    await expect(result).rejects.toBeInstanceOf(HarborHostedStateClientError);
    await expect(result).rejects.toMatchObject({ code: "QUOTA_EXHAUSTED", status: 429,
      retryAfterSeconds: 30, message: "Hosted Pilot state is unavailable." });
  });
});
