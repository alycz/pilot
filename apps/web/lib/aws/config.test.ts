import { describe, expect, it } from "vitest";

import { readPilotAwsConfig } from "./config";

describe("readPilotAwsConfig", () => {
  it("uses safe mock defaults without credentials", () => {
    expect(readPilotAwsConfig({})).toEqual({
      region: "us-east-2",
      bedrockMode: "mock",
      bedrockModels: [],
      bedrockDailyTurnCap: 50,
    });
  });

  it("parses explicit service modes, models, threshold and cap", () => {
    expect(
      readPilotAwsConfig({
        AWS_REGION: "us-east-2",
        BEDROCK_MODE: "aws",
        BEDROCK_MODELS: "provider/model-a, provider/model-b,provider/model-a",
        BEDROCK_DAILY_TURN_CAP: "25",
      }),
    ).toMatchObject({
      region: "us-east-2",
      bedrockMode: "aws",
      bedrockModels: ["provider/model-a", "provider/model-b"],
      bedrockDailyTurnCap: 25,
    });
  });

  it("retains the legacy us-east-1 Pilot region without widening the allowlist", () => {
    expect(readPilotAwsConfig({ AWS_REGION: "us-east-1" }).region).toBe("us-east-1");
  });

  it.each([
    [{ BEDROCK_MODE: "live" }, "BEDROCK_MODE"],
    [{ BEDROCK_MODELS: "bad model" }, "BEDROCK_MODELS"],
    [{ BEDROCK_DAILY_TURN_CAP: "0" }, "BEDROCK_DAILY_TURN_CAP"],
    [{ AWS_REGION: "us-west-2" }, "AWS_REGION"],
  ])("rejects invalid configuration %#", (env, expected) => {
    expect(() => readPilotAwsConfig(env)).toThrow(expected);
  });

  it("never reads or returns the server-only Bedrock bearer token", () => {
    const config = readPilotAwsConfig({
      AWS_BEARER_TOKEN_BEDROCK: "server-secret-test-value",
    });

    expect(config).not.toHaveProperty("bearerToken");
    expect(JSON.stringify(config)).not.toContain("server-secret-test-value");
  });
});
