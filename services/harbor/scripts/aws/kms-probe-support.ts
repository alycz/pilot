import { appendFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type KmsProbeMode = "standin" | "event";

export type KmsProbeCli = {
  mode: KmsProbeMode;
  statusFile?: string;
  storeFile?: string;
  bedrockKeyName?: string;
};

const VALUE_FLAGS = new Set([
  "--mode",
  "--status-file",
  "--store-file",
  "--bedrock-key-name",
]);

export function parseKmsProbeCli(args: readonly string[]): KmsProbeCli {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !VALUE_FLAGS.has(flag) || value === undefined || value.length === 0) {
      throw new Error("INVALID_ARGUMENTS");
    }
    if (parsed[flag] !== undefined) throw new Error("DUPLICATE_ARGUMENT");
    parsed[flag] = value;
  }
  const mode = parsed["--mode"];
  if (mode !== "standin" && mode !== "event") throw new Error("INVALID_MODE");
  const statusFile = parsed["--status-file"]
    ? checkedStatusFile(parsed["--status-file"])
    : undefined;
  return {
    mode,
    ...(statusFile ? { statusFile } : {}),
    ...(parsed["--store-file"] ? { storeFile: resolve(parsed["--store-file"]) } : {}),
    ...(parsed["--bedrock-key-name"] ? { bedrockKeyName: parsed["--bedrock-key-name"] } : {}),
  };
}

function checkedStatusFile(input: string): string {
  if (isAbsolute(input)) throw new Error("INVALID_STATUS_PATH");
  const statusRoot = resolve(process.cwd(), "status");
  const target = resolve(process.cwd(), input);
  const child = relative(statusRoot, target);
  if (
    !child ||
    child.startsWith("..") ||
    isAbsolute(child) ||
    child.includes("/") ||
    child.includes("\\") ||
    !child.endsWith(".md")
  ) {
    throw new Error("INVALID_STATUS_PATH");
  }
  return target;
}

export async function appendProbeStatus(
  statusFile: string | undefined,
  probe: string,
  detail: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (!statusFile) return;
  const safeDetail = detail.replace(/[\r\n|]/g, " ").slice(0, 512);
  await appendFile(
    statusFile,
    `${now().toISOString()} | AWS-6 | ${probe} | pass | ${safeDetail}\n`,
    { encoding: "utf8" },
  );
}

export function exactHarborCleanupAlias(alias: string): boolean {
  return alias === "alias/harbor/kek" ||
    /^alias\/harbor\/(?:testnet|devnet)\/[A-Za-z0-9._-]+$/.test(alias);
}

export const EVENT_AUTHORITY_REQUIRED =
  "EVENT_AUTHORITY_REQUIRED: explicit event lane, funded Testnet owner, owner DelegateSet signer, ledger submission, and operator-supplied AWS settings are required";
