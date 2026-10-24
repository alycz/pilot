import { readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  dispatchAwsLocalRequest,
  type AwsLocalDispatchRequest,
  type AwsLocalDispatchResponse,
} from "../../tools/aws-local/src/server.ts";

const THRESHOLD = 0.8;
const FIXED_AUTHORIZATION =
  "AWS4-HMAC-SHA256 Credential=AWSLOCALTESTONLY/19700101/us-east-1/bedrock/aws4_request";

export const G1_INJECTION_FIXTURES = Object.freeze(
  readFileSync(
    new URL("../../tools/aws-local/fixtures/injections.txt", import.meta.url),
    "utf8",
  )
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0),
);

export const G1_TOKEN_NAMES = Object.freeze([
  "Bitcoin",
  "Ethereum",
  "XRP",
  "Tether",
  "BNB",
  "Solana",
  "USDC",
  "Dogecoin",
  "Cardano",
  "TRON",
  "Avalanche",
  "Chainlink",
  "Stellar",
  "Sui",
  "Hedera",
  "Toncoin",
  "Shiba Inu",
  "Polkadot",
  "Litecoin",
  "Bitcoin Cash",
]);

type Dispatch = (
  request: AwsLocalDispatchRequest,
) => Promise<AwsLocalDispatchResponse>;

export type G1CaseResult = {
  id: string;
  kind: "injection" | "token";
  label: string;
  score: number;
  passed: boolean;
};

export type G1Result = {
  mode: "mock";
  passed: boolean;
  threshold: number;
  cases: G1CaseResult[];
};

export type G1Options = {
  dispatch?: Dispatch;
  output?: (line: string) => void;
  statusPath?: string;
  now?: () => Date;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function severityScore(response: AwsLocalDispatchResponse): number {
  if (response.statusCode !== 200 || !isRecord(response.body)) {
    throw new Error("Guardrails stand-in rejected the probe");
  }
  const results = isRecord(response.body.results) ? response.body.results : null;
  const promptAttack = results && isRecord(results.promptAttack)
    ? results.promptAttack
    : null;
  const entries = promptAttack && Array.isArray(promptAttack.results)
    ? promptAttack.results
    : null;
  if (!entries || entries.length === 0) {
    throw new Error("Guardrails stand-in returned no prompt-attack scores");
  }
  const scores = entries.map((entry) =>
    isRecord(entry) && typeof entry.severityScore === "number"
      ? entry.severityScore
      : Number.NaN,
  );
  if (scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)) {
    throw new Error("Guardrails stand-in returned an invalid score");
  }
  return Math.max(...scores);
}

async function checkText(dispatch: Dispatch, text: string): Promise<number> {
  return severityScore(await dispatch({
    method: "POST",
    authorization: FIXED_AUTHORIZATION,
    path: "/guardrail-checks/invoke",
    contentType: "application/json",
    body: {
      checks: {
        promptAttack: {
          categories: [
            { category: "PROMPT_INJECTION" },
            { category: "JAILBREAK" },
          ],
        },
      },
      messages: [{ role: "user", content: [{ text }] }],
    },
  }));
}

function checkedStatusPath(input: string): string {
  const statusRoot = resolve(process.cwd(), "status");
  const path = resolve(input);
  const pathFromRoot = relative(statusRoot, path);
  if (
    pathFromRoot === "" ||
    pathFromRoot.startsWith("..") ||
    pathFromRoot.includes("/") ||
    pathFromRoot.includes("\\") ||
    !pathFromRoot.endsWith(".md")
  ) {
    throw new Error("Evidence path must be one markdown file directly under status/");
  }
  return path;
}

async function appendEvidence(
  path: string,
  result: G1Result,
  now: () => Date,
): Promise<void> {
  const blocked = result.cases.filter(
    ({ kind, score }) => kind === "injection" && score >= result.threshold,
  ).length;
  const allowed = result.cases.filter(
    ({ kind, score }) => kind === "token" && score < result.threshold,
  ).length;
  const line = `${now().toISOString()} | AWS-6 | g1-guardrails | ${result.passed ? "PASS" : "FAIL"} | mode=mock cases=${result.cases.length} blocked=${blocked} allowed=${allowed}\n`;
  await appendFile(checkedStatusPath(path), line, { encoding: "utf8", mode: 0o600 });
}

export async function runG1Guardrails(options: G1Options = {}): Promise<G1Result> {
  const dispatch = options.dispatch ?? ((request) => dispatchAwsLocalRequest(request));
  const output = options.output ?? (() => undefined);
  const cases: G1CaseResult[] = [];

  for (const [index, text] of G1_INJECTION_FIXTURES.entries()) {
    const score = await checkText(dispatch, text);
    const passed = score >= THRESHOLD;
    const item = {
      id: `injection-${String(index + 1).padStart(2, "0")}`,
      kind: "injection" as const,
      label: `injection fixture ${index + 1}`,
      score,
      passed,
    };
    cases.push(item);
    output(`${item.id} score=${score.toFixed(2)} expected=blocked ${passed ? "PASS" : "FAIL"}`);
  }

  for (const [index, name] of G1_TOKEN_NAMES.entries()) {
    const score = await checkText(dispatch, name);
    const passed = score < THRESHOLD;
    const item = {
      id: `token-${String(index + 1).padStart(2, "0")}`,
      kind: "token" as const,
      label: name,
      score,
      passed,
    };
    cases.push(item);
    output(`${item.id} name=${name} score=${score.toFixed(2)} expected=allowed ${passed ? "PASS" : "FAIL"}`);
  }

  const result: G1Result = {
    mode: "mock",
    passed: cases.every(({ passed }) => passed),
    threshold: THRESHOLD,
    cases,
  };
  output(`g1-guardrails ${result.passed ? "PASS" : "FAIL"} mode=mock cases=${cases.length}`);
  if (options.statusPath) {
    await appendEvidence(options.statusPath, result, options.now ?? (() => new Date()));
  }
  return result;
}

function statusArgument(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length !== 2 || argv[0] !== "--status" || !argv[1]) {
    throw new Error("Usage: g1-guardrails [--status status/H-aws.md]");
  }
  return argv[1];
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  runG1Guardrails({
    statusPath: statusArgument(process.argv.slice(2)),
    output: (line) => process.stdout.write(`${line}\n`),
  }).then((result) => {
    if (!result.passed) process.exitCode = 1;
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "g1-guardrails failed";
    process.stderr.write(`g1-guardrails FAIL: ${message}\n`);
    process.exitCode = 1;
  });
}
