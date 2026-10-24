import {
  awsFetch,
  type AwsFetchEnv,
  type AwsFetchOptions,
  type AwsRequestBody,
} from "./sigv4";

export type GuardrailsMode = "off" | "mock" | "aws";

export type GuardrailsEnv = AwsFetchEnv & {
  GUARDRAILS_MODE?: string;
  GUARDRAILS_THRESHOLD?: string;
};

export type GuardrailCheck = {
  score: number;
};

export type GuardrailFetch = (
  service: string,
  target: string,
  body: AwsRequestBody,
  options: AwsFetchOptions,
) => Promise<unknown>;

export type GuardrailClientOptions = {
  env: GuardrailsEnv;
  fetch?: GuardrailFetch;
};

type JsonRecord = Record<string, unknown>;

const LOCAL_SIGNING_FIXTURE = Object.freeze({
  AWS_ACCESS_KEY_ID: "AWSLOCALTESTONLY",
  AWS_SECRET_ACCESS_KEY: "aws-local-test-only-not-a-credential",
});

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readScore(result: unknown): number {
  if (!isRecord(result) || !isRecord(result.results)) {
    throw new Error("Guardrails returned an invalid response");
  }

  const promptAttack = result.results.promptAttack;
  if (!isRecord(promptAttack) || !Array.isArray(promptAttack.results)) {
    throw new Error("Guardrails returned an invalid prompt-attack result");
  }

  const scores = promptAttack.results.map((entry) => {
    if (!isRecord(entry) || typeof entry.severityScore !== "number") {
      throw new Error("Guardrails returned an invalid severity score");
    }
    const score = entry.severityScore;
    if (!Number.isFinite(score) || score < 0 || score > 1) {
      throw new Error("Guardrails returned an out-of-range severity score");
    }
    return score;
  });

  if (scores.length === 0) {
    throw new Error("Guardrails returned no prompt-attack scores");
  }
  return Math.max(...scores);
}

export function readGuardrailsMode(env: GuardrailsEnv): GuardrailsMode {
  const mode = env.GUARDRAILS_MODE?.trim() || "off";
  if (mode !== "off" && mode !== "mock" && mode !== "aws") {
    throw new Error("GUARDRAILS_MODE must be off, mock, or aws");
  }
  return mode;
}

/**
 * Screen one untrusted string. InvokeGuardrailChecks reports an aggregate
 * score for a request, so callers deliberately submit one field per request.
 */
export async function invokeGuardrailCheck(
  text: string,
  options: GuardrailClientOptions,
): Promise<GuardrailCheck> {
  if (!text) return { score: 0 };
  const mode = readGuardrailsMode(options.env);
  if (mode === "off") {
    throw new Error("Guardrails are disabled");
  }
  if (mode === "mock" && !options.env.AWS_ENDPOINT_OVERRIDE) {
    throw new Error("Mock Guardrails require a local endpoint override");
  }
  // The stand-in requires a SigV4-shaped request but never receives or uses an
  // AWS credential. Ignore any configured values in mock mode and sign with a
  // fixed, conspicuously non-credential fixture.
  const env: AwsFetchEnv =
    mode === "mock"
      ? {
          AWS_REGION: options.env.AWS_REGION,
          AWS_ENDPOINT_OVERRIDE: options.env.AWS_ENDPOINT_OVERRIDE,
          EXEC_NETWORK: options.env.EXEC_NETWORK,
          HARBOR_LOCAL_DEV: options.env.HARBOR_LOCAL_DEV,
          ...LOCAL_SIGNING_FIXTURE,
        }
      : options.env;
  const result = await (options.fetch ?? awsFetch)(
    "bedrock-runtime",
    "InvokeGuardrailChecks",
    {
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
    { env },
  );

  return { score: readScore(result) };
}
