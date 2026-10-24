import { describe, expect, it } from "vitest";

import { XRPL_COVERAGE_METHODS } from "./coverage.ts";
import { parseProbeArgs, runQ1Coverage } from "./q1-coverage.ts";

describe("q1 coverage probe", () => {
  it("accepts the exact coverage method set and records a pass", async () => {
    const lines: string[] = [];
    const output = JSON.stringify({
      network: "testnet",
      source: "endpoint-probe",
      generated_at: "2026-10-21T20:00:00.000Z",
      methods: Object.fromEntries(
        XRPL_COVERAGE_METHODS.map((method) => [method, "supported"]),
      ),
    });
    await runQ1Coverage(
      ["--mode", "mock", "--output", "/tmp/qn-coverage.json", "--status", "/tmp/status.md"],
      {
        coverageRunner: async () => undefined,
        readFile: (async () => output) as never,
        appendFile: (async (_path, line) => {
          lines.push(String(line));
        }) as never,
        stdout: { write: () => true },
        now: () => new Date("2026-10-21T20:00:00.000Z"),
      },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("| pass |");
  });

  it("rejects duplicate CLI arguments", () => {
    expect(() => parseProbeArgs(["--mode", "mock", "--mode", "live"]))
      .toThrow(/Duplicate/);
  });

  it("accepts a strict mock-only coverage fixture", async () => {
    const output = JSON.stringify({
      network: "testnet",
      source: "standin-fixture",
      generated_at: "2026-10-21T20:00:00.000Z",
      methods: Object.fromEntries(
        XRPL_COVERAGE_METHODS.map((method) => [method, "supported"]),
      ),
    });
    const lines: string[] = [];
    await runQ1Coverage(
      ["--mode", "mock", "--fixture", "/tmp/coverage.mock.json", "--status", "/tmp/status.md"],
      {
        coverageRunner: async () => { throw new Error("must not run"); },
        readFile: (async () => output) as never,
        appendFile: (async (_path, line) => lines.push(String(line))) as never,
        stdout: { write: () => true },
      },
    );
    expect(lines[0]).toContain("mock-only");
  });

  it("rejects a fixture in live mode", async () => {
    await expect(runQ1Coverage(
      ["--mode", "live", "--fixture", "/tmp/coverage.mock.json"],
      {
        readFile: (async () => "{}") as never,
        appendFile: (async () => undefined) as never,
        stdout: { write: () => true },
      },
    )).rejects.toThrow(/must probe/);
  });
});
