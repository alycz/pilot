import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  G1_INJECTION_FIXTURES,
  G1_TOKEN_NAMES,
  runG1Guardrails,
} from "../scripts/aws/g1-guardrails.ts";

describe("AWS-6 g1 Guardrails probe", () => {
  it("blocks every injection fixture and allows exactly 20 fixed token names", async () => {
    const output: string[] = [];
    const result = await runG1Guardrails({ output: (line) => output.push(line) });

    expect(G1_INJECTION_FIXTURES).toHaveLength(3);
    expect(G1_TOKEN_NAMES).toHaveLength(20);
    expect(result).toMatchObject({ mode: "mock", passed: true, threshold: 0.8 });
    expect(result.cases).toHaveLength(23);
    expect(result.cases.filter(({ kind }) => kind === "injection"))
      .toSatisfy((items: typeof result.cases) => items.every(({ score }) => score === 0.95));
    expect(result.cases.filter(({ kind }) => kind === "token"))
      .toSatisfy((items: typeof result.cases) => items.every(({ score }) => score === 0.02));
    expect(output.at(-1)).toBe("g1-guardrails PASS mode=mock cases=23");
  });

  it("writes only fixed aggregate evidence to an explicit status path", async () => {
    const root = await mkdtemp(join(tmpdir(), "aws6-g1-"));
    const status = join(root, "evidence");
    await mkdir(status);
    const path = join(status, "aws.md");
    const previous = process.cwd();
    process.chdir(root);
    const previousEvidenceRoot = process.env.HARBOR_PRIVATE_EVIDENCE_ROOT;
    process.env.HARBOR_PRIVATE_EVIDENCE_ROOT = status;
    try {
      await runG1Guardrails({
        statusPath: path,
        now: () => new Date("2026-10-21T20:30:00.000Z"),
      });
      const evidence = await readFile(path, "utf8");
      expect(evidence).toBe(
        "2026-10-21T20:30:00.000Z | AWS-6 | g1-guardrails | PASS | mode=mock cases=23 blocked=3 allowed=20\n",
      );
      for (const text of [...G1_INJECTION_FIXTURES, ...G1_TOKEN_NAMES]) {
        expect(evidence).not.toContain(text);
      }
    } finally {
      process.chdir(previous);
      if (previousEvidenceRoot === undefined) delete process.env.HARBOR_PRIVATE_EVIDENCE_ROOT;
      else process.env.HARBOR_PRIVATE_EVIDENCE_ROOT = previousEvidenceRoot;
    }
  });

  it("refuses to write evidence outside the private evidence root", async () => {
    const root = await mkdtemp(join(tmpdir(), "aws6-g1-"));
    const previous = process.cwd();
    process.chdir(root);
    const previousEvidenceRoot = process.env.HARBOR_PRIVATE_EVIDENCE_ROOT;
    process.env.HARBOR_PRIVATE_EVIDENCE_ROOT = join(root, "evidence");
    try {
      await expect(runG1Guardrails({ statusPath: join(root, "outside.md") }))
        .rejects.toThrow(/directly under HARBOR_PRIVATE_EVIDENCE_ROOT/);
    } finally {
      process.chdir(previous);
      if (previousEvidenceRoot === undefined) delete process.env.HARBOR_PRIVATE_EVIDENCE_ROOT;
      else process.env.HARBOR_PRIVATE_EVIDENCE_ROOT = previousEvidenceRoot;
    }
  });
});
