import { describe, expect, it } from "vitest";

import { OpRegistry } from "../src/catalog/registry";
import { createWorker, type Env } from "../src/server";

function environment(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    ...overrides,
  };
}

async function health(env: Env): Promise<Response> {
  return createWorker(new OpRegistry()).fetch!(
    new Request("https://harbor.example/health"),
    env,
    {} as ExecutionContext,
  );
}

describe("Worker KMS startup validation", () => {
  it("refuses health when kek mode has no ciphertext", async () => {
    const response = await health(environment({ KMS_MODE: "kek" }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        service: "kms",
        kind: "error",
        message: "HARBOR_KEK_CIPHERTEXT is required in KMS KEK mode",
        code: "KMS_CIPHERTEXT_MISSING",
      },
    });
  });

  it.each([
    ["not-canonical-base64", "KMS_CIPHERTEXT_INVALID"],
    [Buffer.alloc(12_289).toString("base64"), "KMS_CIPHERTEXT_INVALID"],
  ])("refuses health for invalid kek ciphertext %#", async (ciphertext, code) => {
    const response = await health(
      environment({
        KMS_MODE: "kek",
        HARBOR_KEK_CIPHERTEXT: ciphertext,
      }),
    );

    expect(response.status).toBe(503);
    const payload = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(payload.error.code).toBe(code);
    expect(payload.error.message).toBe("HARBOR_KEK_CIPHERTEXT is invalid");
    expect(JSON.stringify(payload)).not.toContain(ciphertext);
  });

  it("refuses health for an invalid mode without echoing it", async () => {
    const response = await health(
      environment({ KMS_MODE: "credential-shaped-mode-sentinel" }),
    );

    expect(response.status).toBe(503);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("KMS_INVALID_MODE");
    expect(body).not.toContain("credential-shaped-mode-sentinel");
  });

  it.each([undefined, "off", "sign"])(
    "serves normal health in %s mode without requiring ciphertext",
    async (mode) => {
      const response = await health(environment({ KMS_MODE: mode }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        service: "harbor",
      });
    },
  );
});
