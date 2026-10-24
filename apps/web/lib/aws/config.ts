const AWS_REGION = "us-east-1" as const;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

const BEDROCK_MODES = ["off", "mock", "aws"] as const;

type Env = Readonly<Record<string, string | undefined>>;

export type BedrockMode = (typeof BEDROCK_MODES)[number];

export type PilotAwsConfig = {
  region: typeof AWS_REGION;
  bedrockMode: BedrockMode;
  bedrockModels: string[];
  bedrockDailyTurnCap: number;
};

function parseEnum<const T extends readonly string[]>(
  name: string,
  value: string | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  const candidate = value?.trim() || fallback;
  if (!(allowed as readonly string[]).includes(candidate)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return candidate as T[number];
}

function parseDailyTurnCap(value: string | undefined): number {
  const candidate = value?.trim() || "50";
  const cap = Number(candidate);
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new Error("BEDROCK_DAILY_TURN_CAP must be a positive integer");
  }
  return cap;
}

function parseModelIds(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const models = value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);

  if (models.some((model) => !MODEL_ID_PATTERN.test(model))) {
    throw new Error("BEDROCK_MODELS contains an invalid model id");
  }

  return [...new Set(models)];
}

export function readPilotAwsConfig(
  env: Env = process.env,
): PilotAwsConfig {
  const region = env.AWS_REGION?.trim() || AWS_REGION;
  if (region !== AWS_REGION) {
    throw new Error(`AWS_REGION must be ${AWS_REGION}`);
  }

  return {
    region,
    bedrockMode: parseEnum(
      "BEDROCK_MODE",
      env.BEDROCK_MODE,
      BEDROCK_MODES,
      "mock",
    ),
    bedrockModels: parseModelIds(env.BEDROCK_MODELS),
    bedrockDailyTurnCap: parseDailyTurnCap(env.BEDROCK_DAILY_TURN_CAP),
  };
}
