import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  BedrockProbeError,
  liveBedrockProbeConfig,
  parseBedrockProbeArgs,
  runBedrockProbe,
  runSyntheticToolCallingChat,
} from "./b1-bedrock";

describe("AWS-6 Bedrock probe", () => {
  it("uses configured model IDs in stand-in mode without any credential", () => {
    expect(parseBedrockProbeArgs([], {
      BEDROCK_MODE: "mock",
      BEDROCK_MODELS: "provider/model-a,provider/model-b,provider/model-a",
    })).toEqual({
      mode: "standin",
      models: ["provider/model-a", "provider/model-b"],
      eventLive: false,
    });
  });

  it("uses two clearly synthetic models when mock configuration has no event IDs", () => {
    expect(parseBedrockProbeArgs([], { BEDROCK_MODE: "mock" })).toEqual({
      mode: "standin",
      models: ["standin/haiku-5-5", "standin/sonnet-5-5"],
      eventLive: false,
    });
  });

  it("rejects disabled, malformed, or unexpected CLI inputs", () => {
    for (const [argv, env, code] of [
      [[], { BEDROCK_MODE: "off" }, "BEDROCK_MODE_DISABLED"],
      [["--models", "bad model"], {}, "INVALID_MODELS"],
      [["--unknown"], {}, "UNKNOWN_ARGUMENT"],
      [["--event-live"], {}, "EVENT_LIVE_REQUIRES_AWS_MODE"],
    ] as const) {
      expect(() => parseBedrockProbeArgs(argv, env)).toThrow(
        expect.objectContaining({ code }),
      );
    }
  });

  it("verifies the deterministic synthetic tool-call transcript", async () => {
    await expect(runSyntheticToolCallingChat("standin/model")).resolves.toBe(true);
    await expect(runSyntheticToolCallingChat("bad model")).resolves.toBe(false);
  });

  it("runs every model and emits only fixed synthetic pass metadata", async () => {
    const lines: string[] = [];
    const result = await runBedrockProbe({
      mode: "standin",
      models: ["standin/a", "standin/b"],
      eventLive: false,
    }, { write: (line) => lines.push(line) });

    expect(result).toEqual({
      status: "PASS",
      mode: "standin",
      synthetic: true,
      models: [
        { model: "standin/a", toolCall: "PASS" },
        { model: "standin/b", toolCall: "PASS" },
      ],
    });
    expect(lines).toEqual([
      "B1 model=standin/a mode=standin tool_call=PASS",
      "B1 model=standin/b mode=standin tool_call=PASS",
      "B1 PASS mode=standin models=2 synthetic=true",
    ]);
  });

  it("requires explicit event authorization before invoking a live runner", async () => {
    const liveRunner = vi.fn(async () => true);
    await expect(runBedrockProbe({
      mode: "aws",
      models: ["amazon.nova-lite-v1:0"],
      eventLive: false,
    }, { liveRunner })).rejects.toMatchObject({ code: "AWS_MODE_REQUIRES_EVENT_LIVE" });
    expect(liveRunner).not.toHaveBeenCalled();
  });

  it("uses the same bounded region policy as hosted Pilot", () => {
    expect(liveBedrockProbeConfig("amazon.nova-lite-v1:0", {
      AWS_REGION: "us-east-2",
      BEDROCK_DAILY_TURN_CAP: "25",
    })).toEqual({
      region: "us-east-2",
      bedrockMode: "aws",
      bedrockModels: ["amazon.nova-lite-v1:0"],
      bedrockDailyTurnCap: 25,
    });
    expect(liveBedrockProbeConfig("amazon.nova-lite-v1:0", {
      AWS_REGION: "us-east-1",
    }).region).toBe("us-east-1");
    expect(() => liveBedrockProbeConfig("amazon.nova-lite-v1:0", {
      AWS_REGION: "us-west-2",
    })).toThrow("AWS_REGION");
  });

  it("hides provider errors and model output behind fixed failure metadata", async () => {
    const lines: string[] = [];
    const result = await runBedrockProbe({
      mode: "aws",
      models: ["amazon.nova-lite-v1:0"],
      eventLive: true,
    }, {
      liveRunner: vi.fn(async () => {
        throw new Error("provider body with credential-shaped material");
      }),
      write: (line) => lines.push(line),
    });

    expect(result.status).toBe("FAIL");
    expect(lines.join("\n")).toBe(
      "B1 model=amazon.nova-lite-v1:0 mode=aws tool_call=FAIL\n" +
      "B1 FAIL mode=aws models=1 synthetic=false",
    );
    expect(lines.join("\n")).not.toMatch(/provider body|credential-shaped/);
  });

  it("appends evidence only to an explicit status Markdown path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "aws6-b1-"));
    await runBedrockProbe({
      mode: "standin",
      models: ["standin/a"],
      eventLive: false,
      statusPath: "status/probe.md",
    }, {
      cwd,
      now: () => new Date("2026-10-21T20:00:00.000Z"),
      write: () => undefined,
    });
    await expect(readFile(join(cwd, "status/probe.md"), "utf8")).resolves.toBe(
      "2026-10-21T20:00:00.000Z | AWS-6 b1-bedrock | mode=standin | models=1 | PASS | synthetic=true\n",
    );

    await expect(runBedrockProbe({
      mode: "standin",
      models: ["standin/a"],
      eventLive: false,
      statusPath: "../outside.md",
    }, { cwd, write: () => undefined })).rejects.toBeInstanceOf(BedrockProbeError);
  });
});
