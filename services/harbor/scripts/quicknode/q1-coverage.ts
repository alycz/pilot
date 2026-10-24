import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { z } from "zod";

import {
  runCoverageProbe,
  XRPL_COVERAGE_METHODS,
} from "./coverage.ts";

const ProbeIdSchema = z.enum([
  "q1-coverage",
  "q2-submit",
  "q3-webhook",
  "q4-watchdog",
]);

const CoverageStatusSchema = z.enum([
  "supported",
  "supported_business_error",
  "unsupported",
]);

const CoverageDocumentSchema = z
  .object({
    network: z.literal("testnet"),
    source: z.enum(["endpoint-probe", "standin-fixture"]),
    generated_at: z.string().datetime(),
    methods: z.record(z.string(), CoverageStatusSchema),
  })
  .strict();

export type ProbeMode = "mock" | "live";

export type ProbeIo = Readonly<{
  appendFile?: typeof appendFile;
  stdout?: Pick<NodeJS.WriteStream, "write">;
  now?: () => Date;
}>;

export function parseProbeArgs(argv: readonly string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || value.startsWith("--")) {
      throw new Error("Probe arguments must be --name value pairs");
    }
    if (result.has(name)) throw new Error(`Duplicate probe argument: ${name}`);
    result.set(name, value);
  }
  return result;
}

export function probeMode(value: string | undefined): ProbeMode {
  if (value === "mock" || value === "live") return value;
  throw new Error("Probe mode must be mock or live");
}

function safeNote(value: string): string {
  return value
    .replace(/[\r\n|]/g, " ")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 240);
}

export async function recordProbeResult(
  id: z.infer<typeof ProbeIdSchema>,
  mode: ProbeMode,
  passed: boolean,
  note: string,
  statusPath: string,
  io: ProbeIo = {},
): Promise<void> {
  const now = (io.now ?? (() => new Date()))().toISOString();
  const result = passed ? "pass" : "fail";
  const line = `| 3 | H-qn | QN-6 ${id} | ${now} | ${now} | 1 | ${result} | ${safeNote(note)} |\n`;
  await (io.appendFile ?? appendFile)(statusPath, line, { encoding: "utf8" });
  (io.stdout ?? process.stdout).write(
    `${passed ? "PASS" : "FAIL"} ${id} mode=${mode} ${safeNote(note)}\n`,
  );
}

export function isEntrypoint(metaUrl: string): boolean {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint && metaUrl === pathToFileURL(resolve(entrypoint)).href,
  );
}

export type Q1Dependencies = ProbeIo &
  Readonly<{
    coverageRunner?: () => Promise<void>;
    readFile?: typeof readFile;
  }>;

export async function runQ1Coverage(
  argv = process.argv.slice(2),
  dependencies: Q1Dependencies = {},
): Promise<void> {
  const args = parseProbeArgs(argv);
  const mode = probeMode(args.get("--mode") ?? process.env.QN_MODE);
  const output = resolve(
    args.get("--output") ?? "src/quicknode/coverage.testnet.json",
  );
  const fixture = args.get("--fixture");
  const status = resolve(args.get("--status") ?? "status/H-qn.md");

  try {
    if (fixture && mode === "live") {
      throw new Error("Live q1 must probe QN_XRPL_TESTNET_HTTP, not --fixture");
    }
    if (!fixture) await (dependencies.coverageRunner ?? runCoverageProbe)();
    const raw = await (dependencies.readFile ?? readFile)(
      fixture ? resolve(fixture) : output,
      "utf8",
    );
    const document = CoverageDocumentSchema.parse(JSON.parse(raw));
    if (
      (fixture && document.source !== "standin-fixture") ||
      (!fixture && document.source !== "endpoint-probe")
    ) {
      throw new Error("Coverage source does not match the selected evidence mode");
    }
    const expected = new Set<string>(XRPL_COVERAGE_METHODS);
    const actual = Object.keys(document.methods);
    if (
      actual.length !== expected.size ||
      actual.some((method) => !expected.has(method))
    ) {
      throw new Error("Coverage output does not contain the exact method set");
    }
    await recordProbeResult(
      "q1-coverage",
      mode,
      true,
      fixture
        ? `${actual.length} XRPL methods classified from local stand-in fixture; mock-only`
        : `${actual.length} XRPL methods classified by endpoint probe; endpoint material not recorded`,
      status,
      dependencies,
    );
  } catch (error) {
    await recordProbeResult(
      "q1-coverage",
      mode,
      false,
      "coverage probe failed; inspect local stderr",
      status,
      dependencies,
    );
    throw error;
  }
}

if (isEntrypoint(import.meta.url)) {
  runQ1Coverage().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Coverage probe failed"}\n`,
    );
    process.exitCode = 1;
  });
}
