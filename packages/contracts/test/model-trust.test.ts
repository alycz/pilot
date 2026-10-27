import { describe, expect, it } from "vitest";

import { TrustModelSchema } from "../src/index";

const privacy = {
  tier: "confidential-tee" as const,
  declaredBy: "operator-configuration" as const,
  attestationVerified: false as const,
  summary: "Operator-declared TEE tier; runtime attestation was not verified.",
};

describe("model trust receipts", () => {
  it("requires truthful privacy metadata for NEAR AI", () => {
    expect(TrustModelSchema.parse({
      provider: "near-ai",
      id: "z-ai/example-model",
      privacy,
    })).toEqual({
      provider: "near-ai",
      id: "z-ai/example-model",
      privacy,
    });
    expect(TrustModelSchema.safeParse({
      provider: "near-ai",
      id: "z-ai/example-model",
    }).success).toBe(false);
    expect(TrustModelSchema.safeParse({
      provider: "near-ai",
      id: "z-ai/example-model",
      privacy: { ...privacy, attestationVerified: true },
    }).success).toBe(false);
  });

  it("does not permit NEAR privacy claims on another provider", () => {
    expect(TrustModelSchema.safeParse({
      provider: "openrouter",
      id: "openai/example",
      privacy,
    }).success).toBe(false);
  });
});
