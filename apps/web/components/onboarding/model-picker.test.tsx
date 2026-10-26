import { describe, expect, it } from "vitest";

import {
  friendlyBedrockModelName,
  modelChoiceGroups,
  nearAiModelPrivacyLabel,
} from "./model-picker";

const openRouterModels = [
  { id: "provider/free-tools:free", name: "Free Tools" },
];

describe("modelChoiceGroups", () => {
  it("hides the AWS Bedrock group when Bedrock is off", () => {
    expect(
      modelChoiceGroups(openRouterModels, "off", ["anthropic.claude-3-5-sonnet-v1:0"]),
    ).toEqual([
      { id: "openrouter", label: "OpenRouter", models: openRouterModels },
    ]);
  });

  it.each(["mock", "aws"] as const)(
    "lists configured Bedrock model ids in an AWS Bedrock group for %s mode",
    (mode) => {
      const groups = modelChoiceGroups(openRouterModels, mode, [
        "anthropic.claude-3-5-sonnet-v1:0",
        "amazon.nova-pro-v1:0",
        "amazon.nova-pro-v1:0",
      ]);

      expect(groups[1]).toMatchObject({
        id: "bedrock",
        label: "AWS Bedrock",
        models: [
          {
            id: "anthropic.claude-3-5-sonnet-v1:0",
            name: "Claude 3 5 Sonnet V1 0",
            description: mode === "mock" ? "OpenRouter free-model stand-in" : "AWS Bedrock",
          },
          {
            id: "amazon.nova-pro-v1:0",
            name: "Nova PRO V1 0",
            description: mode === "mock" ? "OpenRouter free-model stand-in" : "AWS Bedrock",
          },
        ],
      });
      expect(groups[1]?.models).toHaveLength(2);
    },
  );

  it("derives a friendly name without exposing configuration data beyond the model id", () => {
    expect(friendlyBedrockModelName("us.amazon.nova-lite-v1:0")).toBe("Amazon Nova Lite V1 0");
  });

  it("preserves and separates NEAR AI provider and privacy metadata", () => {
    const nearAi = {
      id: "deepseek-ai/DeepSeek-V3.1",
      name: "DeepSeek V3.1",
      description: "NEAR AI Cloud model with native tool support",
      provider: "near-ai" as const,
      privacy: {
        tier: "confidential-tee" as const,
        declaredBy: "operator-configuration" as const,
        attestationVerified: false as const,
        summary: "Inference is declared to use NEAR AI's own TEE fleet.",
      },
    };

    expect(modelChoiceGroups([...openRouterModels, nearAi])).toEqual([
      { id: "openrouter", label: "OpenRouter", models: openRouterModels },
      { id: "near-ai", label: "NEAR AI", models: [nearAi] },
    ]);
    expect(nearAiModelPrivacyLabel(nearAi.privacy)).toBe(
      "Confidential TEE · operator-declared · attestation not verified",
    );
  });
});
