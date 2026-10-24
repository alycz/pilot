import { appendFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveChatModel } from "../../apps/web/lib/aws/bedrock";

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const STANDIN_MODELS = [
  "standin/haiku-5-5",
  "standin/sonnet-5-5",
] as const;
const PROBE_NONCE = "aws6-b1-tool-probe";

type ProbeMode = "standin" | "aws";

export type BedrockProbeOptions = {
  mode: ProbeMode;
  models: string[];
  eventLive: boolean;
  statusPath?: string;
};

export type BedrockModelProbe = {
  model: string;
  toolCall: "PASS" | "FAIL";
};

export type BedrockProbeResult = {
  status: "PASS" | "FAIL";
  mode: ProbeMode;
  synthetic: boolean;
  models: BedrockModelProbe[];
};

export type ToolCallingRunner = (model: string) => Promise<boolean>;

export type BedrockProbeDependencies = {
  env?: Readonly<Record<string, string | undefined>>;
  liveRunner?: ToolCallingRunner;
  now?: () => Date;
  cwd?: string;
  write?: (line: string) => void;
};

export class BedrockProbeError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BedrockProbeError";
  }
}

function modelsFrom(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const models = [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (models.length === 0 || models.some((model) => !MODEL_ID_PATTERN.test(model))) {
    throw new BedrockProbeError("INVALID_MODELS");
  }
  return models;
}

function valueAfter(argv: readonly string[], index: number, name: string): string {
  const value = argv[index + 1];
  if (!value?.trim() || value.startsWith("--")) {
    throw new BedrockProbeError(`MISSING_${name}`);
  }
  return value.trim();
}

export function parseBedrockProbeArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): BedrockProbeOptions {
  let mode: ProbeMode | undefined;
  let modelValue: string | undefined;
  let eventLive = false;
  let statusPath: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      const value = valueAfter(argv, index, "MODE");
      if (value !== "standin" && value !== "aws") {
        throw new BedrockProbeError("INVALID_MODE");
      }
      mode = value;
      index += 1;
    } else if (arg === "--models") {
      modelValue = valueAfter(argv, index, "MODELS");
      index += 1;
    } else if (arg === "--status") {
      statusPath = valueAfter(argv, index, "STATUS_PATH");
      index += 1;
    } else if (arg === "--event-live") {
      eventLive = true;
    } else {
      throw new BedrockProbeError("UNKNOWN_ARGUMENT");
    }
  }

  if (mode === undefined) {
    const configured = env.BEDROCK_MODE?.trim() || "mock";
    if (configured === "mock") mode = "standin";
    else if (configured === "aws") mode = "aws";
    else throw new BedrockProbeError("BEDROCK_MODE_DISABLED");
  }

  const configuredModels = modelsFrom(modelValue ?? env.BEDROCK_MODELS);
  const models = configuredModels.length > 0
    ? configuredModels
    : mode === "standin"
      ? [...STANDIN_MODELS]
      : [];
  if (models.length === 0) throw new BedrockProbeError("BEDROCK_MODELS_REQUIRED");
  if (eventLive && mode !== "aws") {
    throw new BedrockProbeError("EVENT_LIVE_REQUIRES_AWS_MODE");
  }

  return {
    mode,
    models,
    eventLive,
    ...(statusPath ? { statusPath } : {}),
  };
}

/**
 * Deterministic, network-free tool-calling transcript used by the stand-in lane.
 * It proves the probe contract without pretending tools/aws-local hosts a model.
 */
export async function runSyntheticToolCallingChat(model: string): Promise<boolean> {
  if (!MODEL_ID_PATTERN.test(model)) return false;
  const transcript = [
    { role: "user", content: `Call probe_echo with nonce ${PROBE_NONCE}.` },
    {
      role: "assistant",
      toolCall: { name: "probe_echo", input: { nonce: PROBE_NONCE } },
    },
    {
      role: "tool",
      name: "probe_echo",
      output: { nonce: PROBE_NONCE, accepted: true },
    },
    { role: "assistant", content: "probe complete" },
  ] as const;
  return (
    transcript[1].toolCall.name === "probe_echo" &&
    transcript[1].toolCall.input.nonce === PROBE_NONCE &&
    transcript[2].name === "probe_echo" &&
    transcript[2].output.nonce === PROBE_NONCE &&
    transcript[2].output.accepted === true
  );
}

async function loadWebPackage(name: "ai" | "zod"): Promise<Record<string, unknown>> {
  const requireFromWeb = createRequire(
    new URL("../../apps/web/package.json", import.meta.url),
  );
  const entry = requireFromWeb.resolve(name);
  return import(pathToFileURL(entry).href) as Promise<Record<string, unknown>>;
}

/** Event-only runner. It is unreachable unless the CLI receives --event-live. */
export async function runAuthorizedBedrockToolCallingChat(
  modelId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<boolean> {
  if (!env.AWS_BEARER_TOKEN_BEDROCK?.trim()) {
    throw new BedrockProbeError("BEDROCK_EVENT_TOKEN_REQUIRED");
  }
  const [aiModule, zodModule] = await Promise.all([
    loadWebPackage("ai"),
    loadWebPackage("zod"),
  ]);
  const generateText = aiModule.generateText as undefined | ((input: Record<string, unknown>) => Promise<{
    steps?: Array<{
      toolCalls?: Array<{ toolName?: string }>;
      toolResults?: Array<{ toolName?: string }>;
    }>;
  }>);
  const tool = aiModule.tool as undefined | ((input: Record<string, unknown>) => unknown);
  const stepCountIs = aiModule.stepCountIs as undefined | ((count: number) => unknown);
  const z = zodModule.z as undefined | {
    object(shape: Record<string, unknown>): unknown;
    literal(value: string): unknown;
  };
  if (!generateText || !tool || !stepCountIs || !z) {
    throw new BedrockProbeError("BEDROCK_EVENT_RUNTIME_UNAVAILABLE");
  }

  const resolved = await resolveChatModel(
    { provider: "bedrock", model: modelId },
    { env, config: {
      region: "us-east-1",
      bedrockMode: "aws",
      bedrockModels: [modelId],
      bedrockDailyTurnCap: 50,
    } },
  );
  const result = await generateText({
    model: resolved.model,
    prompt: `Call probe_echo exactly once with nonce ${PROBE_NONCE}, then finish.`,
    tools: {
      probe_echo: tool({
        description: "Return the fixed AWS-6 Bedrock probe nonce.",
        inputSchema: z.object({ nonce: z.literal(PROBE_NONCE) }),
        execute: async ({ nonce }: { nonce: string }) => ({ nonce, accepted: true }),
      }),
    },
    stopWhen: stepCountIs(2),
  });
  const steps = result.steps ?? [];
  return (
    steps.some((step) => step.toolCalls?.some((call) => call.toolName === "probe_echo")) &&
    steps.some((step) => step.toolResults?.some((entry) => entry.toolName === "probe_echo"))
  );
}

function safeStatusTarget(path: string, cwd: string): string {
  if (isAbsolute(path)) throw new BedrockProbeError("INVALID_STATUS_PATH");
  const statusRoot = resolve(cwd, "status");
  const target = resolve(cwd, path);
  const child = relative(statusRoot, target);
  if (!child || child.startsWith("..") || isAbsolute(child) || !target.endsWith(".md")) {
    throw new BedrockProbeError("INVALID_STATUS_PATH");
  }
  return target;
}

async function appendEvidence(
  path: string,
  result: BedrockProbeResult,
  dependencies: BedrockProbeDependencies,
): Promise<void> {
  const cwd = dependencies.cwd ?? process.cwd();
  const target = safeStatusTarget(path, cwd);
  await mkdir(resolve(cwd, "status"), { recursive: true });
  const timestamp = (dependencies.now ?? (() => new Date()))().toISOString();
  const line = `${timestamp} | AWS-6 b1-bedrock | mode=${result.mode} | models=${result.models.length} | ${result.status} | synthetic=${String(result.synthetic)}\n`;
  await appendFile(target, line, { encoding: "utf8", mode: 0o600 });
}

export async function runBedrockProbe(
  options: BedrockProbeOptions,
  dependencies: BedrockProbeDependencies = {},
): Promise<BedrockProbeResult> {
  if (options.mode === "aws" && !options.eventLive) {
    throw new BedrockProbeError("AWS_MODE_REQUIRES_EVENT_LIVE");
  }
  const env = dependencies.env ?? process.env;
  const runner = options.mode === "standin"
    ? runSyntheticToolCallingChat
    : dependencies.liveRunner ?? ((model) => runAuthorizedBedrockToolCallingChat(model, env));
  const write = dependencies.write ?? console.log;
  const models: BedrockModelProbe[] = [];

  for (const model of options.models) {
    let passed = false;
    try {
      passed = await runner(model);
    } catch {
      passed = false;
    }
    const toolCall = passed ? "PASS" : "FAIL";
    models.push({ model, toolCall });
    write(`B1 model=${model} mode=${options.mode} tool_call=${toolCall}`);
  }

  const result: BedrockProbeResult = {
    status: models.every(({ toolCall }) => toolCall === "PASS") ? "PASS" : "FAIL",
    mode: options.mode,
    synthetic: options.mode === "standin",
    models,
  };
  write(`B1 ${result.status} mode=${result.mode} models=${models.length} synthetic=${String(result.synthetic)}`);
  if (options.statusPath) await appendEvidence(options.statusPath, result, dependencies);
  return result;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  try {
    const result = await runBedrockProbe(parseBedrockProbeArgs(argv, env), { env });
    return result.status === "PASS" ? 0 : 1;
  } catch (error) {
    const code = error instanceof BedrockProbeError ? error.code : "PROBE_FAILED";
    console.error(`B1 FAIL code=${code}`);
    return 1;
  }
}

const invoked = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invoked) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
